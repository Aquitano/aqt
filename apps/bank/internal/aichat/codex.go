package aichat

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

// Codex CLI session rollouts: the .jsonl files under ~/.codex/sessions/ (and
// archived_sessions/). Each line is an envelope {timestamp, type, payload}.
// Only user/assistant text from response_item message payloads is imported —
// reasoning, tool calls and their outputs are noise for search, and whole
// subagent threads (guardian judges and the like, marked by the session_meta's
// thread_source) never were a conversation with the user.

type cxLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type cxMeta struct {
	SessionID    string `json:"session_id"`
	ID           string `json:"id"`
	ThreadSource string `json:"thread_source"`
}

type cxItem struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Role    string `json:"role"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// codexMachineTags open the context blocks Codex injects as user-role
// messages. A block starting with one of these was written by the harness,
// not typed by the user.
var codexMachineTags = []string{
	"<environment_context",
	"<user_instructions",
	"<turn_context",
	"<permissions",
	"<skills_instructions",
	"<collaboration_mode",
}

func codexMachineText(text string) bool {
	for _, tag := range codexMachineTags {
		if strings.HasPrefix(text, tag) {
			return true
		}
	}
	return false
}

// rolloutName pulls the session uuid out of a rollout filename
// (rollout-2026-08-18T17-10-41-<uuid>.jsonl), the thread of last resort when a
// transcript carries no session_meta line.
var rolloutName = regexp.MustCompile(`([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$`)

// ImportCodex ingests one rollout .jsonl or every .jsonl under a directory
// (e.g. ~/.codex/sessions).
func ImportCodex(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return importCodex(ctx, st, archiveDir, path, false)
}

// SyncCodex is ImportCodex for a recurring sweep: a rollout whose exact bytes
// are already archived was fully ingested by an earlier run (archiving
// happens after ingest) and is skipped without being parsed. Subagent and
// empty rollouts are never archived, so a sync still re-parses (and re-drops)
// them each run.
func SyncCodex(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	return importCodex(ctx, st, archiveDir, path, true)
}

func importCodex(ctx context.Context, st *store.Store, archiveDir, path string, onlyChanged bool) (Result, error) {
	var res Result
	info, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	if !info.IsDir() {
		return res, importCodexSession(ctx, st, archiveDir, path, &res, onlyChanged)
	}
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".jsonl") {
			return err
		}
		// One broken transcript must not cost the rest of the walk;
		// operational failures (database, archive, cancelled context) still
		// abort, because continuing would repeat them for every file.
		if err := importCodexSession(ctx, st, archiveDir, p, &res, onlyChanged); err != nil {
			if fail.IsOp(err) {
				return err
			}
			res.FailedSessions = append(res.FailedSessions, p)
			fmt.Fprintf(os.Stderr, "bank: skipping codex session %s: %v\n", p, err)
		}
		return nil
	})
	return res, err
}

func importCodexSession(ctx context.Context, st *store.Store, archiveDir, path string, res *Result, onlyChanged bool) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	name := filepath.Base(path)
	// Refuse a bad archive name before any row exists that references it —
	// ingest runs first, and rows pointing at a ref Replace then rejects
	// would dangle with nothing to heal them.
	if err := archive.ValidName(name); err != nil {
		return err
	}
	if onlyChanged && archive.Identical(archiveDir, "codex", name, raw) {
		res.UnchangedSessions++
		return nil
	}
	fallback := ""
	if m := rolloutName.FindStringSubmatch(name); m != nil {
		fallback = strings.ToLower(m[1])
	}
	msgs, subagent, err := parseCodexSession(bytes.NewReader(raw), fallback)
	if err != nil {
		return err
	}
	if subagent {
		res.SubagentSessions++
		return nil
	}
	if len(msgs) == 0 {
		res.EmptyConversations++
		return nil
	}
	// Ingest before archiving, under the name Replace will use: the bytes
	// become "already archived" only once every message landed, so a run that
	// died mid-ingest re-reads the file instead of skipping it. Replace, not
	// Copy — a rollout grows in place, and keeping every intermediate copy
	// would archive the same ever-longer prefix on every sync.
	res.Conversations++
	if err := res.ingest(ctx, st, "codex", filepath.Join("codex", name), msgs, nil); err != nil {
		return err
	}
	if _, err := archive.Replace(archiveDir, "codex", name, raw); err != nil {
		return fail.Opf("archive %s: %w", path, err)
	}
	return nil
}

// SubagentRollout reports whether the file's first line marks a machine-
// spawned thread. Remote sync peeks at this before uploading: a subagent
// rollout would be skipped server-side anyway, and they are routinely a third
// of the session directory.
func SubagentRollout(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false // let the real importer surface the error
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	if !scanner.Scan() {
		return false
	}
	var l cxLine
	if json.Unmarshal(scanner.Bytes(), &l) != nil || l.Type != "session_meta" {
		return false
	}
	var meta cxMeta
	return json.Unmarshal(l.Payload, &meta) == nil && meta.ThreadSource == "subagent"
}

// parseCodexSession reads one rollout. The thread is the session_meta's
// session_id — `codex resume` appends to the same rollout under the same id,
// so a continued conversation stays one thread. subagent reports a thread the
// session_meta marks as machine-spawned; such a file is skipped whole rather
// than imported as a conversation that never happened.
func parseCodexSession(r io.Reader, fallbackSession string) (msgs []message, subagent bool, err error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 1024*1024), 32*1024*1024)

	session := fallbackSession
	// Not every payload carries an id (user prompts often do not), so those
	// messages are keyed on content instead. The occurrence counter keeps a
	// genuinely repeated prompt ("continue", twice) from collapsing into one.
	occurrence := map[string]int{}
	var out []message
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var l cxLine
		if err := json.Unmarshal(line, &l); err != nil {
			continue // tolerate unknown/corrupt lines rather than losing the session
		}
		switch l.Type {
		case "session_meta":
			var meta cxMeta
			if err := json.Unmarshal(l.Payload, &meta); err != nil {
				continue
			}
			if meta.ThreadSource == "subagent" {
				return nil, true, nil
			}
			if meta.SessionID != "" {
				session = meta.SessionID
			} else if meta.ID != "" {
				session = meta.ID
			}
		case "response_item":
			var item cxItem
			if err := json.Unmarshal(l.Payload, &item); err != nil {
				continue
			}
			if item.Type != "message" || (item.Role != "user" && item.Role != "assistant") {
				continue
			}
			var parts []string
			for _, c := range item.Content {
				text := strings.TrimSpace(c.Text)
				if text == "" {
					continue
				}
				switch c.Type {
				case "input_text":
					if !codexMachineText(text) {
						parts = append(parts, text)
					}
				case "output_text", "text":
					parts = append(parts, text)
				}
			}
			body := strings.TrimSpace(strings.Join(parts, "\n"))
			if body == "" {
				continue
			}
			id := item.ID
			if id == "" {
				key := item.Role + "\x00" + body
				id = codexContentID(session, item.Role, body, occurrence[key])
				occurrence[key]++
			}
			out = append(out, message{
				ExternalID: id,
				Thread:     session,
				Sender:     item.Role,
				Body:       body,
				SentAt:     parseTimestamp(l.Timestamp),
			})
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	// A session_meta after the first messages would have threaded them wrong;
	// in practice it is line one, but the file format does not promise that.
	for i := range out {
		out[i].Thread = session
	}
	return out, false, nil
}

// codexContentID derives a stable id for a message the rollout did not give
// one. Timestamps are deliberately absent: they are the line's write time and
// would change if Codex ever rewrites the file.
func codexContentID(session, role, body string, occurrence int) string {
	sum := sha256.Sum256([]byte("codex\x00" + session + "\x00" + role + "\x00" + strconv.Itoa(occurrence) + "\x00" + body))
	return hex.EncodeToString(sum[:16])
}
