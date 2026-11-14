package aichat

import (
	"context"
	"errors"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

// Claude.ai data export (claude.ai → Settings → Privacy → Export data):
// conversations.json is an array of conversations with flat chat_messages.

type claudeConversation struct {
	UUID         string `json:"uuid"`
	Name         string `json:"name"`
	ChatMessages []struct {
		UUID       string `json:"uuid"`
		ParentUUID string `json:"parent_message_uuid"`
		Text       string `json:"text"`
		Sender     string `json:"sender"` // "human" | "assistant"
		CreatedAt  string `json:"created_at"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"chat_messages"`
}

// Claude reads one zip of the Claude.ai export, which arrives as several:
// conversations, projects, memories and design chats. A bare
// conversations.json works too.
type Claude struct{}

func (Claude) Kind() string { return "claude" }

func (Claude) Parse(_ context.Context, raw ingest.Raw, _ Options, out ingest.Emitter) error {
	exp, err := export.Open(raw)
	if err != nil {
		return err
	}
	defer exp.Close()
	var extras int
	if exp.FS != nil {
		if extras, err = emitClaudeExtras(exp.FS, out); err != nil {
			return err
		}
	}
	files, err := eachConversation(raw, exp.FS, out, func(file string, c claudeConversation) error {
		thread := claudeThread(c)
		named := c.Name
		if named == "" {
			named = thread
		}
		return emitConversation(out, "claude", file+": conversation "+thread, named, parseClaudeConversation(c), nil)
	})
	if err != nil {
		return err
	}
	if files+extras == 0 {
		return errors.New("no conversations, projects, memories or design chats, not a Claude export?")
	}
	return nil
}

// claudeThread picks the conversation's identity. The uuid is the stable one;
// the name is display data and repeats across unrelated conversations.
func claudeThread(c claudeConversation) string {
	if c.UUID != "" {
		return c.UUID
	}
	return c.Name
}

func parseClaudeConversation(c claudeConversation) []message {
	thread := claudeThread(c)
	var out []message
	for _, m := range c.ChatMessages {
		body := strings.TrimSpace(m.Text)
		if body == "" {
			var parts []string
			for _, block := range m.Content {
				if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
					parts = append(parts, block.Text)
				}
			}
			body = strings.TrimSpace(strings.Join(parts, "\n"))
		}
		if body == "" {
			continue // attachment-only or non-text blocks carry nothing to store
		}
		sender := m.Sender
		if sender == "human" {
			sender = "user"
		}
		out = append(out, message{
			ExternalID:       m.UUID,
			ParentExternalID: m.ParentUUID,
			Thread:           thread,
			Subject:          c.Name,
			Sender:           sender,
			Body:             body,
			SentAt:           parseTimestamp(m.CreatedAt),
		})
	}
	return out
}
