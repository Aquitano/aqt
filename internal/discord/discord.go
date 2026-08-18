// Package discord imports the official GDPR data package ("Request all of my
// data"). The package only contains the account owner's side of conversations;
// attachments arrive as CDN URLs (kept in the body — the links expire, so the
// bytes can't be archived from the package alone).
package discord

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

type Result struct {
	Channels   int `json:"channels"`
	Inserted   int `json:"inserted"`
	Duplicates int `json:"duplicates"`
	Skipped    int `json:"skipped"`
	// FailedChannels names the channels whose message file could not be read
	// or parsed. The import continues without them, so partial success has to
	// be visible in the result rather than only in a stderr line that a JSON
	// consumer never sees.
	FailedChannels []string `json:"failed_channels,omitempty"`
}

type message struct {
	ID      string
	SentAt  time.Time
	Body    string
	Channel string
}

// Import reads a data package zip or an unpacked package directory.
func Import(ctx context.Context, st *store.Store, archiveDir, inputPath string) (Result, error) {
	var res Result
	var fsys fs.FS
	rawRef := inputPath

	info, err := os.Stat(inputPath)
	if err != nil {
		return res, err
	}
	if info.IsDir() {
		fsys = os.DirFS(inputPath)
		if abs, err := filepath.Abs(inputPath); err == nil {
			rawRef = abs
		}
		fmt.Fprintf(os.Stderr, "bank: directory input is referenced, not archived — keep %s (or import the original zip)\n", rawRef)
	} else {
		zr, err := zip.OpenReader(inputPath)
		if err != nil {
			return res, err
		}
		defer zr.Close()
		fsys = &zr.Reader
		if rawRef, err = archive.Copy(archiveDir, "discord", inputPath); err != nil {
			return res, err
		}
	}
	// Some packages nest everything under a "package/" root.
	if _, err := fs.Stat(fsys, "messages"); err != nil {
		if _, err := fs.Stat(fsys, "package/messages"); err == nil {
			if fsys, err = fs.Sub(fsys, "package"); err != nil {
				return res, err
			}
		} else {
			return res, fmt.Errorf("%s: no messages/ directory — not a Discord data package?", inputPath)
		}
	}

	channelNames := readIndex(fsys)
	sender := readUsername(fsys)

	dirs, err := fs.ReadDir(fsys, "messages")
	if err != nil {
		return res, err
	}
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		channelID := strings.TrimPrefix(d.Name(), "c")
		channel := channelNames[channelID]
		if channel == "" {
			channel = channelName(fsys, path.Join("messages", d.Name()))
		}
		if channel == "" {
			channel = channelID
		}
		msgs, err := readChannel(fsys, path.Join("messages", d.Name()), channel)
		if err != nil {
			res.FailedChannels = append(res.FailedChannels, channel)
			fmt.Fprintf(os.Stderr, "bank: skipping discord channel %s (%s): %v\n", channel, d.Name(), err)
			continue
		}
		res.Channels++
		for _, m := range msgs {
			if m.Body == "" || m.ID == "" {
				res.Skipped++
				continue
			}
			id, err := st.InsertMessage(ctx, store.Message{
				Source:     "discord",
				ExternalID: m.ID,
				ThreadID:   m.Channel,
				Sender:     sender,
				Body:       m.Body,
				SentAt:     m.SentAt,
				RawRef:     rawRef,
			})
			if err != nil {
				return res, fail.Opf("insert message: %w", err)
			}
			if id == 0 {
				res.Duplicates++
			} else {
				res.Inserted++
			}
		}
	}
	return res, nil
}

// readIndex maps channel id -> human name ("Direct Message with alice", ...).
func readIndex(fsys fs.FS) map[string]string {
	out := map[string]string{}
	raw, err := fs.ReadFile(fsys, "messages/index.json")
	if err != nil {
		return out
	}
	var idx map[string]*string
	if json.Unmarshal(raw, &idx) == nil {
		for id, name := range idx {
			if name != nil {
				out[id] = *name
			}
		}
	}
	return out
}

func channelName(fsys fs.FS, dir string) string {
	raw, err := fs.ReadFile(fsys, path.Join(dir, "channel.json"))
	if err != nil {
		return ""
	}
	var ch struct {
		Name string `json:"name"`
	}
	json.Unmarshal(raw, &ch)
	return ch.Name
}

func readUsername(fsys fs.FS) string {
	raw, err := fs.ReadFile(fsys, "account/user.json")
	if err != nil {
		return "me"
	}
	var u struct {
		Username string `json:"username"`
	}
	if json.Unmarshal(raw, &u) == nil && u.Username != "" {
		return u.Username
	}
	return "me"
}

// readChannel handles both package generations: messages.csv (older) and
// messages.json (newer).
func readChannel(fsys fs.FS, dir, channel string) ([]message, error) {
	if f, err := fsys.Open(path.Join(dir, "messages.csv")); err == nil {
		defer f.Close()
		return parseCSV(f, channel)
	}
	if raw, err := fs.ReadFile(fsys, path.Join(dir, "messages.json")); err == nil {
		return parseJSON(raw, channel)
	}
	return nil, fmt.Errorf("no messages.csv or messages.json")
}

func parseCSV(r io.Reader, channel string) ([]message, error) {
	cr := csv.NewReader(r)
	cr.LazyQuotes = true
	cr.FieldsPerRecord = -1
	header, err := cr.Read()
	if err != nil {
		return nil, err
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.ToLower(strings.TrimSpace(h))] = i
	}
	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return rec[i]
	}
	var out []message
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		out = append(out, buildMessage(get(rec, "id"), get(rec, "timestamp"),
			get(rec, "contents"), get(rec, "attachments"), channel))
	}
}

func parseJSON(raw []byte, channel string) ([]message, error) {
	var rows []struct {
		ID          json.Number `json:"ID"`
		Timestamp   string      `json:"Timestamp"`
		Contents    string      `json:"Contents"`
		Attachments string      `json:"Attachments"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	out := make([]message, 0, len(rows))
	for _, r := range rows {
		out = append(out, buildMessage(r.ID.String(), r.Timestamp, r.Contents, r.Attachments, channel))
	}
	return out, nil
}

func buildMessage(id, timestamp, contents, attachments, channel string) message {
	body := strings.TrimSpace(contents)
	if a := strings.TrimSpace(attachments); a != "" {
		if body != "" {
			body += "\n"
		}
		body += "[attachment] " + a
	}
	return message{ID: id, SentAt: parseTime(timestamp), Body: body, Channel: channel}
}

var timeLayouts = []string{
	"2006-01-02 15:04:05.999999999-07:00",
	"2006-01-02 15:04:05",
	time.RFC3339Nano,
	time.RFC3339,
}

func parseTime(s string) time.Time {
	s = strings.TrimSpace(s)
	for _, layout := range timeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Unix(0, 0)
}
