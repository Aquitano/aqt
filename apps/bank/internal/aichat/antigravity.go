package aichat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Antigravity (Gemini's agentic IDE/CLI) conversations. The conversation
// store itself is protobuf inside per-conversation SQLite files, but every
// conversation also writes a plain JSONL transcript under
// ~/.gemini/antigravity*/brain/<uuid>/.system_generated/logs/, and that is
// what bank reads: one step per line with source, type, created_at and
// content. transcript_full.jsonl is preferred over transcript.jsonl — same
// schema, less truncation.

type agStep struct {
	StepIndex *int   `json:"step_index"`
	Source    string `json:"source"`
	Type      string `json:"type"`
	CreatedAt string `json:"created_at"`
	Content   string `json:"content"`
}

var uuidName = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// agObjective pulls the conversation title out of a CHECKPOINT step, the only
// place the transcript states it.
var agObjective = regexp.MustCompile(`# USER Objective:\s*\n(.+)`)

// ImportAntigravity ingests one transcript file or every conversation under a
// directory (e.g. ~/.gemini/antigravity-cli/brain).
func ImportAntigravity(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return store.RunImport(ctx, st, "antigravity", path, func(ctx context.Context) (Result, error) {
		return importAntigravityUnreported(ctx, st, archiveDir, path)
	})
}

func importAntigravityUnreported(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return importAntigravity(ctx, st, archiveDir, path, false)
}

// SyncAntigravity is ImportAntigravity for a recurring sweep: a transcript
// whose exact bytes are already archived was fully ingested by an earlier run
// (archiving happens after ingest) and is skipped without being parsed.
func SyncAntigravity(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return store.RunImport(ctx, st, "antigravity", path, func(ctx context.Context) (Result, error) {
		return syncAntigravityUnreported(ctx, st, archiveDir, path)
	})
}

func syncAntigravityUnreported(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return importAntigravity(ctx, st, archiveDir, path, true)
}

func importAntigravity(ctx context.Context, st *store.Store, archiveDir, path string, onlyChanged bool) (Result, error) {
	var res Result
	info, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	if !info.IsDir() {
		return res, importAntigravityTranscript(ctx, st, archiveDir, path, &res, onlyChanged)
	}
	// One transcript per conversation, preferring transcript_full.jsonl when
	// both exist.
	transcripts := map[string]string{}
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		base := filepath.Base(p)
		if base != "transcript.jsonl" && base != "transcript_full.jsonl" {
			return nil
		}
		thread, terr := antigravityThreadID(p)
		if terr != nil {
			return nil // a stray transcript outside a conversation dir
		}
		if base == "transcript_full.jsonl" || transcripts[thread] == "" {
			transcripts[thread] = p
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	for _, p := range sortedValues(transcripts) {
		if err := importAntigravityTranscript(ctx, st, archiveDir, p, &res, onlyChanged); err != nil {
			if fail.IsOp(err) {
				return res, err
			}
			res.FailedSessions = append(res.FailedSessions, p)
			fmt.Fprintf(os.Stderr, "bank: skipping antigravity transcript %s: %v\n", p, err)
		}
	}
	return res, nil
}

func sortedValues(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = m[k]
	}
	return out
}

// antigravityThreadID recovers the conversation uuid a transcript belongs to:
// from the brain/<uuid>/.system_generated/logs/ path for a live file, or from
// a <uuid>-transcript.jsonl basename for a staged, uploaded or archived copy.
func antigravityThreadID(path string) (string, error) {
	base := filepath.Base(path)
	if id, ok := strings.CutSuffix(base, "-transcript.jsonl"); ok && uuidName.MatchString(id) {
		return strings.ToLower(id), nil
	}
	dir := filepath.Dir(path) // .../brain/<uuid>/.system_generated/logs
	for range 3 {
		name := filepath.Base(dir)
		if uuidName.MatchString(name) {
			return strings.ToLower(name), nil
		}
		dir = filepath.Dir(dir)
	}
	return "", fmt.Errorf("%s: cannot tell which conversation this transcript belongs to", path)
}

func importAntigravityTranscript(ctx context.Context, st *store.Store, archiveDir, path string, res *Result, onlyChanged bool) error {
	thread, err := antigravityThreadID(path)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	// Archived with the uuid in the name: the live file is always called
	// transcript.jsonl, which would store every conversation under one
	// indistinguishable basename and strand reimport without a thread.
	// Replace, not Write — the transcript grows in place, and one superseding
	// copy per conversation is the complete raw input.
	name := thread + "-transcript.jsonl"
	if onlyChanged && archive.Identical(archiveDir, "antigravity", name, raw) {
		res.UnchangedSessions++
		return nil
	}
	msgs, err := parseAntigravityTranscript(raw, thread)
	if err != nil {
		return err
	}
	if len(msgs) == 0 {
		res.EmptyConversations++
		return nil
	}
	// Ingest before archiving: the bytes become "already archived" only once
	// every message landed, so a run that died mid-ingest re-reads the file
	// instead of skipping it.
	res.Conversations++
	if err := res.ingest(ctx, st, "antigravity", filepath.Join("antigravity", name), msgs, nil); err != nil {
		return err
	}
	if _, err := archive.Replace(archiveDir, "antigravity", name, raw); err != nil {
		return fail.Opf("archive %s: %w", path, err)
	}
	return nil
}

// parseAntigravityTranscript keeps the conversation: the user's typed requests
// (USER_INPUT steps, unwrapped from their harness tags) and the model's prose
// (PLANNER_RESPONSE steps with content). Tool steps and SYSTEM lines are
// noise for search. step_index keys idempotency — steps are append-only.
func parseAntigravityTranscript(raw []byte, thread string) ([]message, error) {
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 1024*1024), 32*1024*1024)

	var subject string
	var out []message
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var s agStep
		if err := json.Unmarshal(line, &s); err != nil {
			continue // tolerate unknown/corrupt lines rather than losing the transcript
		}
		if s.Type == "CHECKPOINT" && subject == "" {
			if m := agObjective.FindStringSubmatch(s.Content); m != nil {
				subject = strings.TrimSpace(m[1])
			}
			continue
		}
		var sender, body string
		switch {
		case s.Type == "USER_INPUT" && s.Content != "":
			sender, body = "user", antigravityUserText(s.Content)
		case s.Type == "PLANNER_RESPONSE" && s.Source == "MODEL" && s.Content != "":
			sender, body = "assistant", strings.TrimSpace(s.Content)
		default:
			continue
		}
		if body == "" {
			continue
		}
		id := ""
		if s.StepIndex != nil {
			id = thread + "#" + strconv.Itoa(*s.StepIndex)
		}
		out = append(out, message{
			ExternalID: id, // empty is skipped (and counted) by ingest
			Thread:     thread,
			Sender:     sender,
			Body:       body,
			SentAt:     parseTimestamp(s.CreatedAt),
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Subject = subject
	}
	return out, nil
}

// antigravityUserText unwraps what the user actually typed from the
// USER_REQUEST envelope; the surrounding ADDITIONAL_METADATA and settings
// blocks are the harness talking. A step without the envelope is kept whole —
// better an odd wrapper in the archive than a lost message.
func antigravityUserText(content string) string {
	const openTag, closeTag = "<USER_REQUEST>", "</USER_REQUEST>"
	start := strings.Index(content, openTag)
	if start < 0 {
		return strings.TrimSpace(content)
	}
	rest := content[start+len(openTag):]
	if end := strings.Index(rest, closeTag); end >= 0 {
		rest = rest[:end]
	}
	return strings.TrimSpace(rest)
}
