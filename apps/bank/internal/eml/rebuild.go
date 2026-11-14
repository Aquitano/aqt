package eml

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/mail"
	"path"
	"strconv"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type RebuildReport struct {
	Apply          bool     `json:"apply"`
	Inputs         int      `json:"inputs"`
	Messages       int      `json:"messages"`
	Skipped        int      `json:"skipped"`
	Missing        int      `json:"missing"`
	UnknownFolders int      `json:"unknown_folders"`
	ThreadChanges  int      `json:"thread_changes"`
	Conflicts      int      `json:"conflicts"`
	Incomplete     int      `json:"incomplete"`
	Invalid        int      `json:"invalid"`
	PreviewResets  int      `json:"preview_resets,omitempty"`
	Issues         []string `json:"issues"`
}

// RebuildMail recomputes the mail projection of one source from the headers
// of its stored eml and mbox inputs, in the order they arrived.
func RebuildMail(ctx context.Context, st *store.Store, blobs *blob.Store, source string, apply bool) (RebuildReport, error) {
	report := RebuildReport{Apply: apply, Issues: []string{}}
	if err := ingest.ValidSource(source); err != nil {
		return report, err
	}
	limits, err := store.MailGroupingLimits()
	if err != nil {
		return report, err
	}
	configuration, err := json.Marshal(limits)
	if err != nil {
		return report, err
	}
	preview := &store.MailPreview{}
	note := func(message string) {
		report.Invalid++
		if len(report.Issues) < 100 {
			report.Issues = append(report.Issues, message)
		}
	}
	ids, err := st.RawInputIDs(ctx, []string{"eml", "mbox"})
	if err != nil {
		return report, err
	}
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		raw, err := st.RawInput(ctx, id)
		if err != nil {
			return report, err
		}
		var opts EMLOptions
		if err := json.Unmarshal(raw.Options, &opts); err != nil {
			note(fmt.Sprintf("raw input %d options: %v", raw.ID, err))
			continue
		}
		if opts.Source != source {
			continue
		}
		if raw.Kind == "mbox" && opts.Mailbox != "" {
			opts.MailboxKind = "export"
		}
		label := "raw input " + strconv.FormatInt(raw.ID, 10)
		report.Inputs++
		visit := func(input io.Reader, contentDigest, locator string) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			envelope, err := mail.ReadMessage(input)
			if err != nil {
				note(label + " " + locator + ": " + err.Error())
				return nil
			}
			message := parseHeader(envelope.Header)
			externalID := opts.ExternalID
			if externalID == "" {
				externalID = message.MessageID
				if externalID == "" {
					externalID = contentDigest
				}
			}
			id, err := st.ResolveMailMessage(ctx, source, message.MessageID, externalID)
			if err != nil {
				return err
			}
			if id == 0 {
				report.Missing++
				return nil
			}
			workKey := fieldhash.Hex("mail-projection-v5", raw.BLAKE3.String(), string(raw.Options), string(configuration), contentDigest)
			done, err := st.MailRebuildDone(ctx, source, workKey, id)
			if err != nil {
				return err
			}
			if done {
				report.Skipped++
				return nil
			}
			facts := store.MailProjection{MessageID: message.NormalizedMessageID, InReplyTo: message.InReplyTo, References: message.References,
				RawInput: raw.ID, NativeThreadID: message.nativeThreadID(opts.ThreadID, raw.Kind == "mbox" && source == "gmail"),
				PreserveNative: true, PreserveHeaders: true}
			if box := opts.mailbox(); box != nil {
				facts.Mailbox = &store.MailboxObservation{Kind: box.Kind, Paths: box.Paths}
			}
			var projection store.MailProjectionResult
			if apply {
				projection, err = st.ProjectMail(ctx, id, facts, true, workKey)
			} else {
				projection, err = st.PreviewMail(ctx, id, facts, preview)
			}
			if err != nil {
				return err
			}
			report.Messages++
			if opts.Mailbox == "" {
				report.UnknownFolders++
			}
			if projection.ThreadID != projection.PreviousThreadID {
				report.ThreadChanges++
			}
			if projection.Conflict {
				report.Conflicts++
			}
			if projection.Incomplete {
				report.Incomplete++
				if !apply {
					return fmt.Errorf("read-only preview stopped at incomplete grouping; raise the grouping limits before previewing later inputs")
				}
			}
			return nil
		}
		if err := rebuildInput(raw, blobs, visit); err != nil {
			return report, fmt.Errorf("%s: %w", label, err)
		}
	}
	report.PreviewResets = preview.Resets
	if report.Invalid > 0 {
		return report, fmt.Errorf("%d invalid inputs; see rebuild issues", report.Invalid)
	}
	return report, nil
}

// rebuildInput visits every message of one stored input with the digest its
// default external id is derived from. A single message's digest is its raw
// input's, so only messages inside an mbox or a zip are hashed here.
func rebuildInput(raw store.RawInput, blobs *blob.Store, visit func(io.Reader, string, string) error) error {
	sum := func(data []byte) string { return content.Sum(data).String() }
	input := ingest.Raw{Name: raw.Name, Path: blobs.Path(raw.BLAKE3)}
	if raw.Kind == "mbox" {
		f, err := input.Open()
		if err != nil {
			return err
		}
		defer f.Close()
		n := 0
		return SplitMbox(f, func(data []byte) error {
			n++
			return visit(bytes.NewReader(data), sum(data), fmt.Sprintf("message %d", n))
		})
	}
	if !export.IsZip(raw.Name) {
		f, err := input.Open()
		if err != nil {
			return err
		}
		defer f.Close()
		return visit(f, raw.BLAKE3.String(), "")
	}
	exp, err := export.Open(input)
	if err != nil {
		return err
	}
	defer exp.Close()
	return fs.WalkDir(exp.FS, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(path.Ext(name), ".eml") {
			return err
		}
		data, err := fs.ReadFile(exp.FS, name)
		if err != nil {
			return err
		}
		return visit(bytes.NewReader(data), sum(data), name)
	})
}
