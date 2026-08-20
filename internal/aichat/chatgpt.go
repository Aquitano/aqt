package aichat

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/aquitano/aqt-bank/internal/store"
)

// ChatGPT data export (chatgpt.com → Settings → Data controls → Export data):
// conversations.json is an array of conversations whose messages form a tree
// in "mapping" (regenerations create branches). All user/assistant nodes are
// imported, so no branch is lost.

type cgptConversation struct {
	Title          string              `json:"title"`
	ConversationID string              `json:"conversation_id"`
	ID             string              `json:"id"`
	Mapping        map[string]cgptNode `json:"mapping"`
}

type cgptNode struct {
	Message *struct {
		ID     string `json:"id"`
		Author struct {
			Role string `json:"role"`
		} `json:"author"`
		CreateTime *float64 `json:"create_time"`
		Content    struct {
			ContentType string            `json:"content_type"`
			Parts       []json.RawMessage `json:"parts"`
			Text        string            `json:"text"`
		} `json:"content"`
	} `json:"message"`
}

func ImportChatGPT(ctx context.Context, st *store.Store, archiveDir, path string) (Result, error) {
	var res Result
	raw, rawRef, err := loadConversations(archiveDir, "chatgpt", path)
	if err != nil {
		return res, err
	}
	var convs []cgptConversation
	if err := json.Unmarshal(raw, &convs); err != nil {
		return res, err
	}
	for _, c := range convs {
		msgs := parseChatGPTConversation(c)
		if len(msgs) == 0 {
			res.EmptyConversations++
			continue
		}
		res.Conversations++
		if err := res.ingest(ctx, st, "chatgpt", rawRef, msgs); err != nil {
			return res, err
		}
	}
	return res, nil
}

func parseChatGPTConversation(c cgptConversation) []message {
	// conversation_id is the stable identity; the title is display data and
	// repeats across unrelated chats ("New chat"). Falling back to the title is
	// a last resort for an export that carries neither id.
	thread := c.ConversationID
	if thread == "" {
		thread = c.ID
	}
	if thread == "" {
		thread = c.Title
	}
	var out []message
	for _, node := range c.Mapping {
		m := node.Message
		if m == nil || (m.Author.Role != "user" && m.Author.Role != "assistant") {
			continue
		}
		var body string
		if strings.TrimSpace(m.Content.Text) != "" {
			body = m.Content.Text // content_type "code" and friends: indentation is content
		}
		if body == "" {
			var parts []string
			for _, p := range m.Content.Parts {
				if s := partText(p); s != "" {
					parts = append(parts, s)
				}
			}
			if len(parts) == 0 {
				continue
			}
			body = joinParts(parts)
		}
		var sentAt time.Time
		if m.CreateTime != nil {
			// create_time carries fractional seconds, and a user/assistant pair
			// routinely lands within the same second — truncating would leave
			// their order to chance.
			sec, frac := math.Modf(*m.CreateTime)
			sentAt = time.Unix(int64(sec), int64(frac*1e9))
		}
		out = append(out, message{
			ExternalID: m.ID,
			Thread:     thread,
			Subject:    c.Title,
			Sender:     m.Author.Role,
			Body:       body,
			SentAt:     sentAt,
		})
	}
	// Mapping is a map, so ties must break on something deterministic or the
	// order of same-instant messages changes on every import.
	sort.Slice(out, func(i, j int) bool {
		if !out[i].SentAt.Equal(out[j].SentAt) {
			return out[i].SentAt.Before(out[j].SentAt)
		}
		return out[i].ExternalID < out[j].ExternalID
	})
	return out
}

// partText returns the text a content part contributes. Most parts are plain
// strings; a voice conversation instead carries objects, of which only
// "audio_transcription" holds the spoken words. Asset pointers (images, the
// .wav blobs behind a transcription) carry no text and are skipped.
func partText(p json.RawMessage) string {
	var s string
	if json.Unmarshal(p, &s) == nil {
		return strings.TrimSpace(s)
	}
	var obj struct {
		ContentType string `json:"content_type"`
		Text        string `json:"text"`
	}
	if json.Unmarshal(p, &obj) == nil && obj.ContentType == "audio_transcription" {
		return strings.TrimSpace(obj.Text)
	}
	return ""
}

func joinParts(parts []string) string {
	if len(parts) == 1 {
		return parts[0]
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += "\n" + p
	}
	return out
}
