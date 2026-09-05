package aichat

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

// The Claude.ai export arrives as several zips, not one: conversations,
// projects (each with its uploaded docs), memories (what Claude remembers
// about the account), and design chats. `bank import claude` takes any of
// them; this file covers everything that is not conversations.json.
// light_metadata (users.json, login_history.json) holds no messages and has
// nothing to import.

// claudeExtra is one importable JSON file from a non-conversations zip,
// identified by the directory the export files it under.
type claudeExtra struct {
	kind string // "projects" | "memories" | "design_chats"
	name string
	read func() ([]byte, error)
}

var claudeExtraKinds = map[string]bool{"projects": true, "memories": true, "design_chats": true}

// claudeExtraEntry classifies one path inside an export zip or directory.
func claudeExtraEntry(name string) (string, bool) {
	dir := filepath.Base(filepath.Dir(name))
	if claudeExtraKinds[dir] && strings.EqualFold(filepath.Ext(name), ".json") {
		return dir, true
	}
	return "", false
}

func importClaudeExtras(ctx context.Context, st *store.Store, res *Result, rawRef string, extras []claudeExtra) error {
	// Name order keeps runs deterministic; zip and directory listings differ.
	sort.Slice(extras, func(i, j int) bool { return extras[i].name < extras[j].name })
	for _, e := range extras {
		raw, err := e.read()
		if err != nil {
			return fail.Opf("read %s: %w", e.name, err)
		}
		var msgs []message
		switch e.kind {
		case "projects":
			msgs, err = parseClaudeProject(raw)
		case "memories":
			msgs, err = parseClaudeMemory(raw)
		case "design_chats":
			msgs, err = parseClaudeDesignChat(raw)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", e.name, err)
		}
		if len(msgs) == 0 {
			res.EmptyConversations++
			continue
		}
		res.Conversations++
		if err := res.ingest(ctx, st, "claude", rawRef, msgs, nil); err != nil {
			return err
		}
	}
	return nil
}

// A project is a container: its description and prompt template are one
// message, every uploaded doc another, all threaded under the project's uuid.
type claudeProject struct {
	UUID           string `json:"uuid"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	IsStarter      bool   `json:"is_starter_project"`
	PromptTemplate string `json:"prompt_template"`
	CreatedAt      string `json:"created_at"`
	Docs           []struct {
		UUID      string `json:"uuid"`
		Filename  string `json:"filename"`
		Content   string `json:"content"`
		CreatedAt string `json:"created_at"`
	} `json:"docs"`
}

func parseClaudeProject(raw []byte) ([]message, error) {
	var p claudeProject
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.IsStarter {
		// Starter projects ("How to use Claude") and their docs are Anthropic's
		// onboarding content, not something the owner wrote or received.
		return nil, nil
	}
	var out []message
	if body := strings.TrimSpace(strings.TrimSpace(p.Description) + "\n\n" + strings.TrimSpace(p.PromptTemplate)); body != "" {
		out = append(out, message{
			ExternalID: p.UUID,
			Thread:     p.UUID,
			Subject:    p.Name,
			Sender:     "user",
			Body:       body,
			SentAt:     parseTimestamp(p.CreatedAt),
		})
	}
	for _, d := range p.Docs {
		if strings.TrimSpace(d.Content) == "" {
			continue
		}
		subject := p.Name
		if d.Filename != "" {
			subject = p.Name + " — " + d.Filename
		}
		out = append(out, message{
			ExternalID: d.UUID,
			Thread:     p.UUID,
			Subject:    subject,
			Sender:     "user",
			Body:       d.Content,
			SentAt:     parseTimestamp(d.CreatedAt),
		})
	}
	return out, nil
}

// Memory is Claude's own running notes about the account: one blob for
// conversations, one per project. The file carries no timestamps, and the
// text is rewritten in place as it evolves, so each version's external id is
// a hash of its content — a re-export with updated memory archives the new
// version alongside the old instead of silently keeping only the first.
type claudeMemory struct {
	ConversationsMemory string            `json:"conversations_memory"`
	ProjectMemories     map[string]string `json:"project_memories"`
	AccountUUID         string            `json:"account_uuid"`
}

func parseClaudeMemory(raw []byte) ([]message, error) {
	var m claudeMemory
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	version := func(body string) string {
		sum := sha256.Sum256([]byte(body))
		return "memory-" + hex.EncodeToString(sum[:8])
	}
	var out []message
	if body := strings.TrimSpace(m.ConversationsMemory); body != "" {
		out = append(out, message{
			ExternalID: version(body),
			Thread:     "memory",
			Subject:    "Claude memory",
			Sender:     "assistant",
			Body:       body,
		})
	}
	// Sorted so identical input yields identical message order.
	ids := make([]string, 0, len(m.ProjectMemories))
	for id := range m.ProjectMemories {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		body := strings.TrimSpace(m.ProjectMemories[id])
		if body == "" {
			continue
		}
		out = append(out, message{
			ExternalID: version(id + "\x00" + body),
			Thread:     "memory",
			Subject:    "Claude project memory " + id,
			Sender:     "assistant",
			Body:       body,
		})
	}
	return out, nil
}

// A design chat is a regular conversation with a heavier message envelope:
// the text sits in content.content, or in text content blocks when the
// assistant's turn was mostly tool calls.
type claudeDesignChat struct {
	UUID    string `json:"uuid"`
	Title   string `json:"title"`
	Project struct {
		Name string `json:"name"`
	} `json:"project"`
	Messages []struct {
		UUID      string `json:"uuid"`
		Role      string `json:"role"`
		CreatedAt string `json:"created_at"`
		Content   struct {
			Content       string `json:"content"`
			ContentBlocks []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"contentBlocks"`
		} `json:"content"`
	} `json:"messages"`
}

func parseClaudeDesignChat(raw []byte) ([]message, error) {
	var c claudeDesignChat
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	subject := c.Title
	if c.Project.Name != "" {
		subject = c.Project.Name + " — " + c.Title
	}
	var out []message
	for _, m := range c.Messages {
		body := strings.TrimSpace(m.Content.Content)
		if body == "" {
			var parts []string
			for _, b := range m.Content.ContentBlocks {
				if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
					parts = append(parts, strings.TrimSpace(b.Text))
				}
			}
			body = strings.Join(parts, "\n")
		}
		if body == "" {
			continue
		}
		sender := m.Role
		if sender == "human" {
			sender = "user"
		}
		out = append(out, message{
			ExternalID: m.UUID,
			Thread:     c.UUID,
			Subject:    subject,
			Sender:     sender,
			Body:       body,
			SentAt:     parseTimestamp(m.CreatedAt),
		})
	}
	return out, nil
}

// loadClaudeExtras finds the importable files of a non-conversations export
// zip or directory. The returned closer owns the zip handle the readers pull
// from; nothing found means this input holds conversations (or nothing).
func loadClaudeExtras(path string, isDir bool) ([]claudeExtra, func(), error) {
	noop := func() {}
	if isDir {
		var extras []claudeExtra
		err := filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			if kind, ok := claudeExtraEntry(p); ok {
				extras = append(extras, claudeExtra{kind: kind, name: p, read: func() ([]byte, error) { return os.ReadFile(p) }})
			}
			return nil
		})
		return extras, noop, err
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, noop, err
	}
	var extras []claudeExtra
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if kind, ok := claudeExtraEntry(f.Name); ok {
			extras = append(extras, claudeExtra{kind: kind, name: f.Name, read: func() ([]byte, error) {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}})
		}
	}
	if len(extras) == 0 {
		zr.Close()
		return nil, noop, nil
	}
	return extras, func() { zr.Close() }, nil
}

// hasClaudeConversations reports whether the input also carries a
// conversations.json or numbered shards, so a mixed folder imports both.
func hasClaudeConversations(path string, isDir bool) bool {
	if isDir {
		if _, err := os.Stat(filepath.Join(path, "conversations.json")); err == nil {
			return true
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return false
		}
		for _, e := range entries {
			if _, ok := shardNumber(e.Name()); ok {
				return true
			}
		}
		return false
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return false
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name == "conversations.json" {
			return true
		}
		if _, ok := shardNumber(f.Name); ok {
			return true
		}
	}
	return false
}

// importClaudeExtraInput archives the input and runs every extra through the
// parsers. The whole zip (or each file of a directory walk) is the raw input.
func importClaudeExtraInput(ctx context.Context, st *store.Store, res *Result, archiveDir, path string, extras []claudeExtra, isDir bool) error {
	if !isDir {
		rawRef, err := archive.Copy(archiveDir, "claude", path)
		if err != nil {
			return fail.Opf("archive %s: %w", path, err)
		}
		return importClaudeExtras(ctx, st, res, rawRef, extras)
	}
	// Directory files are archived one by one — there is no single input file.
	for i := range extras {
		e := extras[i]
		rawRef, err := archive.Copy(archiveDir, "claude", e.name)
		if err != nil {
			return fail.Opf("archive %s: %w", e.name, err)
		}
		if err := importClaudeExtras(ctx, st, res, rawRef, []claudeExtra{e}); err != nil {
			return err
		}
	}
	return nil
}
