package aichat

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/aquitano/aqt-bank/internal/store"
)

// Claude.ai data export (claude.ai → Settings → Privacy → Export data):
// conversations.json is an array of conversations with flat chat_messages.

type claudeConversation struct {
	UUID         string `json:"uuid"`
	Name         string `json:"name"`
	ChatMessages []struct {
		UUID      string `json:"uuid"`
		Text      string `json:"text"`
		Sender    string `json:"sender"` // "human" | "assistant"
		CreatedAt string `json:"created_at"`
		Content   []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"chat_messages"`
}

func ImportClaude(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	var res Result
	raw, rawRef, err := loadConversations(archiveDir, "claude", path)
	if err != nil {
		return res, err
	}
	var convs []claudeConversation
	if err := json.Unmarshal(raw, &convs); err != nil {
		return res, err
	}
	for _, c := range convs {
		msgs := parseClaudeConversation(c)
		if len(msgs) == 0 {
			res.EmptyConversations++
			continue
		}
		res.Conversations++
		if err := res.ingest(ctx, st, "claude", rawRef, msgs); err != nil {
			return res, err
		}
	}
	return res, nil
}

func parseClaudeConversation(c claudeConversation) []message {
	thread := c.Name
	if thread == "" {
		thread = c.UUID
	}
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
			ExternalID: m.UUID,
			Thread:     thread,
			Sender:     sender,
			Body:       body,
			SentAt:     parseTimestamp(m.CreatedAt),
		})
	}
	return out
}
