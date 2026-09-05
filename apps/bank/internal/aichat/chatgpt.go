package aichat

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// ChatGPT data export (chatgpt.com → Settings → Data controls → Export data):
// conversations.json is an array of conversations whose messages form a tree
// in "mapping" (regenerations create branches). All user/assistant nodes are
// imported, so no branch is lost.
//
// Uploaded and generated files ship alongside as <asset-id>.dat, with
// conversation_asset_file_names.json mapping those names back to the original
// filenames. Messages reference assets two ways: metadata.attachments entries
// (uploads, with name and mime type) and asset_pointer values inside content
// parts (images, audio — "file-service://file-…" and "sediment://file_…").

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
		Metadata struct {
			Attachments []cgptAttachment `json:"attachments"`
		} `json:"metadata"`
	} `json:"message"`
}

type cgptAttachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Both spellings appear in real exports, in different eras.
	Mime    string `json:"mime_type"`
	MimeAlt string `json:"mimeType"`
}

func ImportChatGPT(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, path string) (Result, error) {
	var res Result
	raw, rawRef, md, closeExport, err := loadChatGPTExport(archiveDir, blobs, path)
	if err != nil {
		return res, err
	}
	defer closeExport()
	var convs []cgptConversation
	if err := json.Unmarshal(raw, &convs); err != nil {
		return res, err
	}
	for _, c := range convs {
		msgs := parseChatGPTConversation(c, md != nil)
		if len(msgs) == 0 {
			res.EmptyConversations++
			continue
		}
		res.Conversations++
		if err := res.ingest(ctx, st, "chatgpt", rawRef, msgs, md); err != nil {
			return res, err
		}
	}
	return res, nil
}

// parseChatGPTConversation flattens one conversation tree. withAssets keeps
// messages that carry only asset references and no text — worth importing
// exactly when the input brings the files along; a bare conversations.json
// still drops them, so its empty-conversation accounting stays truthful.
func parseChatGPTConversation(c cgptConversation, withAssets bool) []message {
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
		var refs []assetRef
		seen := map[string]bool{}
		for _, a := range m.Metadata.Attachments {
			if a.ID == "" || seen[a.ID] {
				continue
			}
			seen[a.ID] = true
			mime := a.Mime
			if mime == "" {
				mime = a.MimeAlt
			}
			name := a.Name
			if name == a.ID {
				name = "" // an id repeated as the name says nothing
			}
			refs = append(refs, assetRef{ID: a.ID, Name: name, Mime: mime})
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
				for _, id := range assetPointerIDs(p) {
					if !seen[id] {
						seen[id] = true
						refs = append(refs, assetRef{ID: id})
					}
				}
			}
			if len(parts) == 0 && (!withAssets || len(refs) == 0) {
				continue
			}
			body = strings.Join(parts, "\n")
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
			ExternalID:  m.ID,
			Thread:      thread,
			Subject:     c.Title,
			Sender:      m.Author.Role,
			Body:        body,
			SentAt:      sentAt,
			Attachments: refs,
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

// assetPointerIDs collects every asset_pointer in one content part. A walk
// rather than a struct because the pointer sits at different depths per part
// type — top-level in image parts, nested inside audio and video parts.
// String parts carry no pointers, so they return nothing.
func assetPointerIDs(raw json.RawMessage) []string {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	var ids []string
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			for k, val := range t {
				if k == "asset_pointer" {
					if s, ok := val.(string); ok {
						if id := assetID(s); id != "" {
							ids = append(ids, id)
						}
						continue
					}
				}
				walk(val)
			}
		case []any:
			for _, val := range t {
				walk(val)
			}
		}
	}
	walk(v)
	return ids
}

// assetIDName is the shape asset ids actually take ("file-<base62>",
// "file_<hex>") and doubles as the path-safety check: an id that matches
// cannot name anything outside the export.
var assetIDName = regexp.MustCompile(`^file[-_][A-Za-z0-9]+$`)

// assetID extracts the id from a pointer like "file-service://file-x" or
// "sediment://file_0f…"; anything unrecognized is dropped rather than guessed.
func assetID(pointer string) string {
	_, id, ok := strings.Cut(pointer, "://")
	if ok && assetIDName.MatchString(id) {
		return id
	}
	return ""
}

// loadChatGPTExport is loadConversations plus the export's media: an opener
// for <asset-id>.dat files and the original-filename map, when the input is
// a directory or zip that carries them. A bare conversations.json has no
// media and imports text-only, exactly as before.
func loadChatGPTExport(archiveDir string, blobs *blob.Store, path string) ([]byte, string, *media, func(), error) {
	noop := func() {}
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", nil, noop, err
	}
	switch {
	case info.IsDir():
		raw, rawRef, err := loadConversations(archiveDir, "chatgpt", path)
		if err != nil {
			return nil, "", nil, noop, err
		}
		md := &media{
			blobs: blobs,
			names: loadAssetNames(func() ([]byte, error) {
				return os.ReadFile(filepath.Join(path, "conversation_asset_file_names.json"))
			}),
			open: func(id string) io.ReadCloser {
				if !assetIDName.MatchString(id) {
					return nil
				}
				f, err := os.Open(filepath.Join(path, id+".dat"))
				if err != nil {
					return nil
				}
				return f
			},
		}
		return raw, rawRef, md, noop, nil
	case strings.EqualFold(filepath.Ext(path), ".zip"):
		raw, rawRef, err := loadConversations(archiveDir, "chatgpt", path)
		if err != nil {
			return nil, "", nil, noop, err
		}
		zr, err := zip.OpenReader(path)
		if err != nil {
			return nil, "", nil, noop, err
		}
		byName := map[string]*zip.File{}
		for _, f := range zr.File {
			byName[filepath.Base(f.Name)] = f
		}
		md := &media{
			blobs: blobs,
			names: loadAssetNames(func() ([]byte, error) {
				f, ok := byName["conversation_asset_file_names.json"]
				if !ok {
					return nil, fs.ErrNotExist
				}
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}),
			open: func(id string) io.ReadCloser {
				if !assetIDName.MatchString(id) {
					return nil
				}
				f, ok := byName[id+".dat"]
				if !ok {
					return nil
				}
				rc, err := f.Open()
				if err != nil {
					return nil
				}
				return rc
			},
		}
		return raw, rawRef, md, func() { zr.Close() }, nil
	default:
		raw, rawRef, err := loadConversations(archiveDir, "chatgpt", path)
		return raw, rawRef, nil, noop, err
	}
}

// loadAssetNames reads conversation_asset_file_names.json ("<id>.dat" →
// original filename). The file is optional and only improves display names,
// so any failure just means empty.
func loadAssetNames(read func() ([]byte, error)) map[string]string {
	raw, err := read()
	if err != nil {
		return nil
	}
	var names map[string]string
	if json.Unmarshal(raw, &names) != nil {
		return nil
	}
	return names
}
