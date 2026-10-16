package aichat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/store"
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

func ImportClaude(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	var res Result
	// The export is several zips; anything that is not conversations
	// (projects, memories, design chats) is handled by claudeextras.go. An
	// input holding both — a folder the owner unpacked everything into —
	// imports both.
	var extrasFound bool
	if info, err := os.Stat(path); err == nil && (info.IsDir() || strings.EqualFold(filepath.Ext(path), ".zip")) {
		extras, closeExtras, err := loadClaudeExtras(path, info.IsDir())
		if err != nil {
			return res, err
		}
		if len(extras) > 0 {
			defer closeExtras()
			extrasFound = true
			if err := importClaudeExtraInput(ctx, st, &res, archiveDir, path, extras, info.IsDir()); err != nil {
				return res, err
			}
		}
		if extrasFound && !hasClaudeConversations(path, info.IsDir()) {
			return res, nil
		}
	}
	raw, rawRef, err := loadConversations(archiveDir, "claude", path, ctx)
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
		if err := res.ingest(ctx, st, "claude", rawRef, msgs, nil); err != nil {
			return res, err
		}
	}
	return res, nil
}

func parseClaudeConversation(c claudeConversation) []message {
	// The uuid is the stable identity; the name is display data and repeats
	// across unrelated conversations.
	thread := c.UUID
	if thread == "" {
		thread = c.Name
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
