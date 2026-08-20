package aichat

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

// Claude Code session transcripts: the .jsonl files under
// ~/.claude/projects/<project>/. Only user/assistant text is imported —
// tool calls, tool results, meta lines and subagent sidechains are noise
// for search.

type ccLine struct {
	Type      string `json:"type"`
	UUID      string `json:"uuid"`
	Timestamp string `json:"timestamp"`
	SessionID string `json:"sessionId"`
	IsMeta    bool   `json:"isMeta"`
	// IsSidechain marks subagent traffic: machine-written prompts and their
	// answers, stored either inline or as whole agent-*.jsonl transcripts.
	IsSidechain bool   `json:"isSidechain"`
	Summary     string `json:"summary"`
	Message     *struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// ImportClaudeCode ingests one session .jsonl or every .jsonl under a
// directory (e.g. ~/.claude/projects).
func ImportClaudeCode(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	var res Result
	info, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	if !info.IsDir() {
		return res, importSession(ctx, st, archiveDir, path, &res)
	}
	// One unreadable or structurally broken transcript must not cost every
	// later session in the tree. Operational failures — the database, the
	// archive, a cancelled context — still abort, because continuing past
	// those would just produce a longer list of the same failure.
	type session struct {
		path string
		last time.Time
	}
	var sessions []session
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".jsonl") {
			return err
		}
		last, err := sessionLastTimestamp(p)
		if err != nil {
			res.FailedSessions = append(res.FailedSessions, p)
			fmt.Fprintf(os.Stderr, "bank: skipping claude-code session %s: %v\n", p, err)
			return nil
		}
		sessions = append(sessions, session{path: p, last: last})
		return nil
	})
	if err != nil {
		return res, err
	}
	// A resumed session replays its predecessor's messages under the same
	// uuids, and rethreading gives the shared prefix to whichever file imports
	// last. Importing in last-message order makes that the fullest transcript,
	// keeping a resumed conversation in one thread instead of splitting it by
	// whatever order the walk happened to visit the files.
	sort.Slice(sessions, func(i, j int) bool {
		if !sessions[i].last.Equal(sessions[j].last) {
			return sessions[i].last.Before(sessions[j].last)
		}
		return sessions[i].path < sessions[j].path
	})
	for _, s := range sessions {
		if err := importSession(ctx, st, archiveDir, s.path, &res); err != nil {
			if fail.IsOp(err) {
				return res, err
			}
			res.FailedSessions = append(res.FailedSessions, s.path)
			fmt.Fprintf(os.Stderr, "bank: skipping claude-code session %s: %v\n", s.path, err)
		}
	}
	return res, nil
}

// sessionLastTimestamp reads a transcript just far enough to order it among
// its siblings: the time of the newest message it holds.
func sessionLastTimestamp(path string) (time.Time, error) {
	f, err := os.Open(path)
	if err != nil {
		return time.Time{}, err
	}
	defer f.Close()
	msgs, _, err := parseClaudeCodeSession(f, "")
	if err != nil {
		return time.Time{}, err
	}
	var last time.Time
	for _, m := range msgs {
		if m.SentAt.After(last) {
			last = m.SentAt
		}
	}
	return last, nil
}

func importSession(ctx context.Context, st *store.Store, archiveDir, path string, res *Result) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	msgs, sidechain, err := parseClaudeCodeSession(f, strings.TrimSuffix(filepath.Base(path), ".jsonl"))
	f.Close()
	if err != nil {
		return err
	}
	if len(msgs) == 0 {
		if sidechain {
			res.SubagentSessions++
		} else {
			res.EmptyConversations++
		}
		return nil
	}
	rawRef, err := archive.Copy(archiveDir, "claude-code", path)
	if err != nil {
		return fail.Opf("archive %s: %w", path, err)
	}
	res.Conversations++
	return res.ingest(ctx, st, "claude-code", rawRef, msgs)
}

// parseClaudeCodeSession reads one transcript. session is the session id the
// file is named after: it is the thread, because two sessions can carry the
// same summary and are still two conversations. The summary is the subject.
// sidechain reports whether subagent lines were dropped, so a transcript that
// was nothing but a subagent's machine traffic can be counted as such rather
// than as an empty conversation.
func parseClaudeCodeSession(r io.Reader, session string) (msgs []message, sidechain bool, err error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 1024*1024), 32*1024*1024)

	var subject string
	var out []message
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var l ccLine
		if err := json.Unmarshal(line, &l); err != nil {
			continue // tolerate unknown/corrupt lines rather than losing the session
		}
		if l.Type == "summary" && l.Summary != "" && subject == "" {
			subject = l.Summary
			continue
		}
		if l.IsSidechain {
			// Subagent traffic: the "user" here is a machine-written prompt,
			// not the user, and a whole agent transcript of it would import
			// as a nameless conversation that never happened.
			sidechain = true
			continue
		}
		if (l.Type != "user" && l.Type != "assistant") || l.IsMeta || l.Message == nil {
			continue
		}
		body := extractText(l.Message.Content)
		if body == "" {
			continue
		}
		out = append(out, message{
			ExternalID: l.UUID,
			Thread:     session,
			Sender:     l.Message.Role,
			Body:       body,
			SentAt:     parseTimestamp(l.Timestamp),
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	// The summary line often appears after messages were already collected.
	for i := range out {
		out[i].Subject = subject
	}
	return out, sidechain, nil
}

// extractText handles both content shapes: a plain string, or an array of
// blocks from which only "text" blocks are kept (tool_use/tool_result are
// dropped).
func extractText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}
