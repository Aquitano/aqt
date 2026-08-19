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
	"strings"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

// Claude Code session transcripts: the .jsonl files under
// ~/.claude/projects/<project>/. Only user/assistant text is imported —
// tool calls, tool results and meta lines are noise for search.

type ccLine struct {
	Type      string `json:"type"`
	UUID      string `json:"uuid"`
	Timestamp string `json:"timestamp"`
	SessionID string `json:"sessionId"`
	IsMeta    bool   `json:"isMeta"`
	Summary   string `json:"summary"`
	Message   *struct {
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
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".jsonl") {
			return err
		}
		if err := importSession(ctx, st, archiveDir, p, &res); err != nil {
			if fail.IsOp(err) {
				return err
			}
			res.FailedSessions = append(res.FailedSessions, p)
			fmt.Fprintf(os.Stderr, "bank: skipping claude-code session %s: %v\n", p, err)
		}
		return nil
	})
	return res, err
}

func importSession(ctx context.Context, st *store.Store, archiveDir, path string, res *Result) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	msgs, err := parseClaudeCodeSession(f, strings.TrimSuffix(filepath.Base(path), ".jsonl"))
	f.Close()
	if err != nil {
		return err
	}
	if len(msgs) == 0 {
		res.EmptyConversations++
		return nil
	}
	rawRef, err := archive.Copy(archiveDir, "claude-code", path)
	if err != nil {
		return fail.Opf("archive %s: %w", path, err)
	}
	res.Conversations++
	return res.ingest(ctx, st, "claude-code", rawRef, msgs)
}

func parseClaudeCodeSession(r io.Reader, fallbackThread string) ([]message, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 1024*1024), 32*1024*1024)

	thread := fallbackThread
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
		if l.Type == "summary" && l.Summary != "" && thread == fallbackThread {
			thread = l.Summary
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
			Thread:     thread,
			Sender:     l.Message.Role,
			Body:       body,
			SentAt:     parseTimestamp(l.Timestamp),
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	// The summary line often appears after messages were already collected.
	for i := range out {
		out[i].Thread = thread
	}
	return out, nil
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
