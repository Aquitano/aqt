package aichat

import (
	"encoding/json"
	"errors"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

// Everything in a Claude.ai export that is not conversations.json: projects
// (each with its uploaded docs), memories (what Claude remembers about the
// account), and design chats. light_metadata (users.json,
// login_history.json) holds no messages and has nothing to import.

var claudeExtraKinds = map[string]bool{"projects": true, "memories": true, "design_chats": true}

// claudeExtraKind classifies one path inside an export zip by the directory
// the export files it under.
func claudeExtraKind(name string) (string, bool) {
	dir := path.Base(path.Dir(name))
	if claudeExtraKinds[dir] && strings.EqualFold(path.Ext(name), ".json") {
		return dir, true
	}
	return "", false
}

var errStarterProject = errors.New("starter project")

// emitClaudeExtras emits every project, memory and design chat in the zip and
// returns how many files it found.
func emitClaudeExtras(fsys fs.FS, out ingest.Emitter) (int, error) {
	var names []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if _, ok := claudeExtraKind(p); ok {
			names = append(names, p)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	for _, name := range names {
		kind, _ := claudeExtraKind(name)
		raw, err := fs.ReadFile(fsys, name)
		if err != nil {
			out.Issue(ingest.Issuef(ingest.Rejected, "%s: %v", name, err))
			continue
		}
		var msgs []message
		switch kind {
		case "projects":
			msgs, err = parseClaudeProject(raw)
		case "memories":
			msgs, err = parseClaudeMemory(raw)
		case "design_chats":
			msgs, err = parseClaudeDesignChat(raw)
		}
		switch {
		case errors.Is(err, errStarterProject):
			out.Issue(ingest.Issuef(ingest.Dropped, "%s is a starter project", name))
			continue
		case err != nil:
			out.Issue(ingest.Issuef(ingest.Rejected, "%s: %v", name, err))
			continue
		}
		if err := emitConversation(out, "claude", name, name, msgs, nil); err != nil {
			return 0, err
		}
	}
	return len(names), nil
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
		return nil, errStarterProject
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
// conversations, one per project. The file carries no timestamps, so its
// messages are undated. The text is rewritten in place as it evolves, so each
// version's external id is a hash of its content: a re-export with updated
// memory archives the new version alongside the old instead of silently
// keeping only the first.
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
		return "memory-" + fieldhash.Hex(body)[:16]
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
