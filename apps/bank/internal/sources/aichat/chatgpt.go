package aichat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
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
	Parent  string `json:"parent"`
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

// ChatGPT reads conversations.json itself or the export zip, whose
// conversations may be split into numbered shards and whose assets ride along.
type ChatGPT struct{}

func (ChatGPT) Kind() string { return "chatgpt" }

func (ChatGPT) Parse(_ context.Context, raw ingest.Raw, _ Options, out ingest.Emitter) error {
	exp, err := ingest.OpenExport(raw)
	if err != nil {
		return err
	}
	defer exp.Close()
	assets := loadChatGPTAssets(exp.FS)
	files, err := eachConversation(raw, exp.FS, out, func(file string, c cgptConversation) error {
		reportUnsupported(out, c)
		thread := chatGPTThread(c)
		named := c.Title
		if named == "" {
			named = thread
		}
		return emitConversation(out, "chatgpt", file+": conversation "+thread, named, parseChatGPTConversation(c), assets.part)
	})
	if err != nil {
		return err
	}
	if files == 0 {
		return errors.New("no conversations.json or conversations-N.json shards, not a data export?")
	}
	return nil
}

func reportUnsupported(out ingest.Emitter, c cgptConversation) {
	keys := make([]string, 0, len(c.Mapping))
	for key := range c.Mapping {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		m := c.Mapping[key].Message
		if m == nil || (m.Author.Role != "user" && m.Author.Role != "assistant") {
			continue
		}
		for _, part := range m.Content.Parts {
			var plain string
			if json.Unmarshal(part, &plain) == nil || partText(part) != "" || len(assetPointerIDs(part)) > 0 {
				continue
			}
			out.Issue(ingest.Issuef(ingest.Unsupported, "unsupported content in message %s (%s)", key, c.Title))
		}
		if len(m.Content.Parts) == 0 && strings.TrimSpace(m.Content.Text) == "" && len(m.Metadata.Attachments) == 0 {
			out.Issue(ingest.Issuef(ingest.Unsupported, "empty or unsupported message %s (%s)", key, c.Title))
		}
	}
}

// chatGPTThread picks the conversation's identity. conversation_id is the
// stable one; the title is display data and repeats across unrelated chats
// ("New chat"), so falling back to it is a last resort for an export that
// carries neither id.
func chatGPTThread(c cgptConversation) string {
	switch {
	case c.ConversationID != "":
		return c.ConversationID
	case c.ID != "":
		return c.ID
	}
	return c.Title
}

// parseChatGPTConversation keeps the tree relationships on a deterministic
// chronological list. Asset-only messages are kept so missing files are
// reported even when the input carries no media.
func parseChatGPTConversation(c cgptConversation) []message {
	thread := chatGPTThread(c)
	var out []message
	for nodeID, node := range c.Mapping {
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
			if len(parts) == 0 && len(refs) == 0 {
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
			ExternalID:       m.ID,
			ParentExternalID: chatGPTParent(c.Mapping, node.Parent),
			BranchID:         nodeID,
			Thread:           thread,
			Subject:          c.Title,
			Sender:           m.Author.Role,
			Body:             body,
			SentAt:           sentAt,
			Attachments:      refs,
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
	applyChatGPTBranches(c.Mapping, out)
	return out
}

// Resolve through structural and tool nodes, while guarding malformed cycles.
func chatGPTParent(nodes map[string]cgptNode, parent string) string {
	seen := map[string]bool{}
	for parent != "" && !seen[parent] {
		seen[parent] = true
		node, ok := nodes[parent]
		if !ok {
			return parent
		}
		if node.Message != nil && (node.Message.Author.Role == "user" || node.Message.Author.Role == "assistant") && node.Message.ID != "" {
			return node.Message.ID
		}
		parent = node.Parent
	}
	return ""
}

func applyChatGPTBranches(nodes map[string]cgptNode, messages []message) {
	children := map[string][]int{}
	byID := map[string]int{}
	for i, m := range messages {
		parent := m.ParentExternalID
		if parent == "" && nodes[m.BranchID].Parent != "" {
			parent = "node:" + nodes[m.BranchID].Parent
		}
		children[parent] = append(children[parent], i)
		byID[m.ExternalID] = i
	}
	forks := map[string]string{}
	for parent, indices := range children {
		if parent == "" || len(indices) < 2 {
			continue
		}
		answer := 0
		for _, i := range indices {
			forks[messages[i].ExternalID] = messages[i].BranchID
			if messages[i].Sender == "assistant" {
				answer++
				messages[i].AlternativeIndex = answer
			}
		}
	}
	for i := range messages {
		id := messages[i].ExternalID
		seen := map[string]bool{}
		messages[i].BranchID = ""
		for id != "" && !seen[id] {
			seen[id] = true
			if branch := forks[id]; branch != "" {
				messages[i].BranchID = branch
				break
			}
			ancestor, ok := byID[id]
			if !ok {
				break
			}
			id = messages[ancestor].ParentExternalID
		}
	}
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

// chatGPTAssets finds an export's <asset-id>.dat files by name anywhere in the
// zip, with the original filenames from conversation_asset_file_names.json. A
// bare conversations.json has none, so every reference becomes a part the
// input lacks.
type chatGPTAssets struct {
	fsys  fs.FS
	paths map[string]string
	// names maps "<id>.dat" to the file's original upload name.
	names map[string]string
}

func loadChatGPTAssets(fsys fs.FS) chatGPTAssets {
	a := chatGPTAssets{fsys: fsys, paths: map[string]string{}}
	if fsys == nil {
		return a
	}
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			a.paths[path.Base(p)] = p
		}
		return nil
	})
	// The names file only improves display names, so any failure just means
	// none.
	if p, ok := a.paths["conversation_asset_file_names.json"]; ok {
		if raw, err := fs.ReadFile(fsys, p); err == nil {
			_ = json.Unmarshal(raw, &a.names)
		}
	}
	return a
}

func (a chatGPTAssets) part(ref assetRef) ingest.Part {
	name := a.names[ref.ID+".dat"]
	if name == "" {
		name = ref.Name
	}
	if name == "" {
		name = ref.ID
	}
	part := ingest.Part{Filename: name, MimeType: ref.Mime}
	if p, ok := a.paths[ref.ID+".dat"]; ok && assetIDName.MatchString(ref.ID) {
		part.Open = func() (io.ReadCloser, error) { return a.fsys.Open(p) }
	}
	return part
}
