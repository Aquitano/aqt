package eml

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/mail"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
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

func RebuildMail(ctx context.Context, st *store.Store, root, source string, apply bool) (RebuildReport, error) {
	report := RebuildReport{Apply: apply, Issues: []string{}}
	if err := archive.ValidSource(source); err != nil {
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
	project := func(record archive.MailContextRecord, identity string) error {
		input, err := archive.OpenMailRaw(root, record)
		if err != nil {
			note(record.RawRef + ": " + err.Error())
			return nil
		}
		defer input.Close()
		digest := sha256.New()
		if _, err := io.Copy(digest, input); err != nil {
			return err
		}
		if _, err := input.Seek(0, io.SeekStart); err != nil {
			return err
		}
		rawDigest := hex.EncodeToString(digest.Sum(nil))
		prefix := "mail-projection-v4:" + identity + ":" + rawDigest + ":" + string(configuration)
		report.Inputs++
		visit := func(input io.Reader, contentDigest string) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			envelope, err := mail.ReadMessage(input)
			if err != nil {
				note(record.RawRef + ": " + err.Error())
				return nil
			}
			message := parseHeader(envelope.Header)
			externalID := record.ExternalID
			if externalID == "" {
				externalID = message.MessageID
				if externalID == "" {
					externalID = contentDigest
				}
			}
			id, err := st.ResolveMailMessage(ctx, source, message.MessageID, externalID)
			if err == nil && id == 0 && record.ExternalID == "" && source == "gmail" && record.InputKind == "eml" {
				id, err = st.FindMessageID(ctx, source, strings.TrimSuffix(path.Base(record.RawRef), ".eml"))
			}
			if err != nil {
				return err
			}
			if id == 0 {
				report.Missing++
				return nil
			}
			digest := sha256.Sum256([]byte(prefix + contentDigest))
			workKey := hex.EncodeToString(digest[:])
			done, err := st.MailRebuildDone(ctx, source, workKey, id)
			if err != nil {
				return err
			}
			if done {
				report.Skipped++
				return nil
			}
			facts := store.MailProjection{MessageID: message.NormalizedMessageID, InReplyTo: message.InReplyTo, References: message.References, RawRef: record.RawRef, NativeThreadID: message.nativeThreadID(record.ThreadID, record.InputKind == "mbox" && source == "gmail"), PreserveNative: true, PreserveHeaders: true, Context: record.Context}
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
			if record.Context == nil {
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
		if record.InputKind == "mbox" {
			return SplitMbox(input, func(raw []byte) error {
				digest := sha256.Sum256(raw)
				return visit(bytes.NewReader(raw), hex.EncodeToString(digest[:]))
			})
		}
		return visit(input, rawDigest)
	}
	known := make(map[string]bool)
	contexts, err := os.ReadDir(filepath.Join(root, source, ".mail-contexts"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return report, err
	}
	for _, entry := range contexts {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		record, err := archive.ReadMailContext(root, source, entry.Name())
		if err != nil {
			note(entry.Name() + ": " + err.Error())
			continue
		}
		known[record.RawRef] = true
		if err := project(record, entry.Name()); err != nil {
			return report, err
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, source))
	if err != nil {
		return report, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension != ".eml" && extension != ".mbox" {
			continue
		}
		reference := source + "/" + entry.Name()
		if known[reference] {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			note(reference + ": symlink skipped")
			continue
		}
		if err := project(archive.MailContextRecord{Version: 1, Source: source, RawRef: reference, InputKind: strings.TrimPrefix(extension, ".")}, "raw"); err != nil {
			return report, err
		}
	}
	report.PreviewResets = preview.Resets
	if report.Invalid > 0 {
		return report, fmt.Errorf("%d invalid archive inputs; see rebuild issues", report.Invalid)
	}
	return report, nil
}
