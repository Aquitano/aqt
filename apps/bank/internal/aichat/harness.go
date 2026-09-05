package aichat

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// A Harness is one locally installed AI coding tool: where it keeps sessions
// on disk and which importer reads them. `bank import ai` walks this registry
// so syncing a machine's AI conversations needs no per-tool paths, and each
// probed root is reported — "0 sessions" must be distinguishable from "looked
// in the wrong place".
type Harness struct {
	// Kind doubles as the import kind and the archive source.
	Kind string
	// Roots are the directories the tool is known to use. Candidates: a
	// missing root is reported, never an error.
	Roots func() []string
	// Sync ingests one file or everything under a directory, skipping session
	// files whose exact bytes are already archived. `bank import <kind>
	// <path>` and reimport use the full Import* variants instead, so an
	// explicit replay is never short-circuited by the archive.
	Sync func(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error)
	// Files lists the individual session files under an existing root for
	// transports that move one file at a time (remote import). staging is a
	// directory the harness may materialize files into when the on-disk form
	// cannot be shipped as-is (a live SQLite database, a transcript whose
	// conversation id lives in its path rather than its name).
	Files func(root, staging string) ([]string, error)
}

// Harnesses lists every AI coding tool bank can discover locally. Order is
// import order and display order.
func Harnesses() []Harness {
	return []Harness{
		{
			Kind:  "claude-code",
			Roots: claudeCodeRoots,
			Sync:  SyncClaudeCode,
			Files: claudeCodeFiles,
		},
		{
			Kind:  "codex",
			Roots: codexRoots,
			Sync:  SyncCodex,
			Files: codexFiles,
		},
		{
			Kind:  "opencode",
			Roots: openCodeRoots,
			Sync:  SyncOpenCode,
			Files: openCodeFiles,
		},
		{
			Kind:  "antigravity",
			Roots: antigravityRoots,
			Sync:  SyncAntigravity,
			Files: antigravityFiles,
		},
	}
}

// HarnessByKind reports the harness registered under kind, if any.
func HarnessByKind(kind string) (Harness, bool) {
	for _, h := range Harnesses() {
		if h.Kind == kind {
			return h, true
		}
	}
	return Harness{}, false
}

func claudeCodeRoots() []string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return []string{filepath.Join(dir, "projects")}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".claude", "projects")}
}

func codexRoots() []string {
	base := os.Getenv("CODEX_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		base = filepath.Join(home, ".codex")
	}
	// Codex moves archived conversations into a flat directory next to the
	// dated tree; archiving must not erase them from the bank.
	return []string{filepath.Join(base, "sessions"), filepath.Join(base, "archived_sessions")}
}

func openCodeRoots() []string {
	if dir := os.Getenv("OPENCODE_DATA_DIR"); dir != "" {
		return []string{dir}
	}
	if dir := os.Getenv("XDG_DATA_HOME"); dir != "" {
		return []string{filepath.Join(dir, "opencode")}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []string{filepath.Join(home, ".local", "share", "opencode")}
}

func antigravityRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var roots []string
	for _, app := range []string{"antigravity", "antigravity-cli", "antigravity-ide"} {
		roots = append(roots, filepath.Join(home, ".gemini", app, "brain"))
	}
	return roots
}

func listJSONLFiles(root string, skip func(path string) bool) ([]string, error) {
	if info, err := os.Stat(root); err != nil {
		return nil, err
	} else if !info.IsDir() {
		return []string{root}, nil
	}
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".jsonl") {
			return err
		}
		if skip != nil && skip(p) {
			return nil
		}
		out = append(out, p)
		return nil
	})
	return out, err
}

// claudeCodeFiles lists session transcripts for upload, leaving out the
// agent-*.jsonl subagent sidechains the importer would drop anyway.
func claudeCodeFiles(root, _ string) ([]string, error) {
	return listJSONLFiles(root, func(p string) bool {
		return strings.HasPrefix(filepath.Base(p), "agent-")
	})
}

// codexFiles lists rollouts for upload, leaving out subagent threads — the
// importer would drop them anyway, and they are routinely a third of the
// session directory.
func codexFiles(root, _ string) ([]string, error) {
	return listJSONLFiles(root, SubagentRollout)
}

// openCodeFiles stages a consistent snapshot of the database: the live file
// cannot be uploaded while OpenCode may be writing it. root may be the data
// directory or the database file itself. The staged name carries this host's
// discriminator so two machines syncing into one server archive side by side
// instead of superseding each other.
func openCodeFiles(root, staging string) ([]string, error) {
	path := root
	if info, err := os.Stat(root); err != nil {
		return nil, err
	} else if info.IsDir() {
		path = filepath.Join(root, "opencode.db")
		if _, err := os.Stat(path); err != nil {
			return nil, nil // a data dir with no database yet is nothing to sync
		}
	}
	db, cleanup, err := snapshotOpenCodeDB(path)
	if err != nil {
		return nil, err
	}
	// The snapshot lives in its own temp dir; copy it into the caller's
	// staging so the caller's cleanup owns its lifetime.
	staged := filepath.Join(staging, openCodeArchiveName(filepath.Base(path)))
	err = copyFile(db, staged)
	cleanup()
	if err != nil {
		return nil, err
	}
	return []string{staged}, nil
}

// antigravityFiles copies each conversation's transcript into staging under
// its uuid: the live basename is always transcript.jsonl, and the conversation
// id would otherwise be lost in transit.
func antigravityFiles(root, staging string) ([]string, error) {
	if info, err := os.Stat(root); err != nil {
		return nil, err
	} else if !info.IsDir() {
		// A single file must resolve to a conversation or fail loudly —
		// returning an empty list would make a remote import of a mis-named
		// transcript print nothing and exit 0.
		thread, err := antigravityThreadID(root)
		if err != nil {
			return nil, err
		}
		staged := filepath.Join(staging, thread+"-transcript.jsonl")
		if err := copyFile(root, staged); err != nil {
			return nil, err
		}
		return []string{staged}, nil
	}
	transcripts := map[string]string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		base := filepath.Base(p)
		if base != "transcript.jsonl" && base != "transcript_full.jsonl" && !strings.HasSuffix(base, "-transcript.jsonl") {
			return nil
		}
		thread, terr := antigravityThreadID(p)
		if terr != nil {
			return nil
		}
		if base == "transcript_full.jsonl" || transcripts[thread] == "" {
			transcripts[thread] = p
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	var out []string
	for thread, p := range transcripts {
		staged := filepath.Join(staging, thread+"-transcript.jsonl")
		if err := copyFile(p, staged); err != nil {
			return nil, err
		}
		out = append(out, staged)
	}
	sort.Strings(out)
	return out, nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o600)
}

// A HarnessRun is one probed root's outcome, the unit `bank import ai`
// reports in.
type HarnessRun struct {
	Kind    string  `json:"kind"`
	Root    string  `json:"root"`
	Missing bool    `json:"missing,omitempty"`
	Result  *Result `json:"result,omitempty"`
	Error   string  `json:"error,omitempty"`
}

// ImportAll runs every harness against every default root. Missing roots and
// per-root parse failures land in the runs; operational failures (database,
// archive, cancelled context) abort.
func ImportAll(ctx context.Context, st *store.Store, archiveDir string) ([]HarnessRun, error) {
	var runs []HarnessRun
	for _, h := range Harnesses() {
		for _, root := range h.Roots() {
			if _, err := os.Stat(root); err != nil {
				runs = append(runs, HarnessRun{Kind: h.Kind, Root: root, Missing: true})
				continue
			}
			res, err := h.Sync(ctx, st, archiveDir, root)
			run := HarnessRun{Kind: h.Kind, Root: root, Result: &res}
			if err != nil {
				if fail.IsOp(err) {
					return runs, err
				}
				run.Error = err.Error()
			}
			runs = append(runs, run)
		}
	}
	return runs, nil
}
