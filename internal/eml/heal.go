package eml

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

// BodyHeal is one archived mail whose raw bytes parse into a longer body than
// the database holds.
type BodyHeal struct {
	ID      int64  `json:"id"`
	Ref     string `json:"ref"` // the archived raw the text came back from
	Subject string `json:"subject,omitempty"`
	// Stored and Reparsed are trimmed byte lengths, the quantity the heal rule
	// compares.
	Stored   int `json:"stored"`
	Reparsed int `json:"reparsed"`
	// Applied is false in a dry run, and false in the rare case where the
	// guarded update found the row no longer shorter.
	Applied bool `json:"applied"`
}

// HealResult counts one pass over a source's archived mail.
type HealResult struct {
	Files    int  `json:"files"`    // archived raws that held mail
	Messages int  `json:"messages"` // messages read out of them
	Matched  int  `json:"matched"`  // of those, ones still in the database
	Healed   int  `json:"healed"`   // bodies replaced, or replaceable in a dry run
	Rejected int  `json:"rejected"` // messages today's parser cannot read
	Applied  bool `json:"applied"`  // false when this was a dry run
}

// HealBodies re-reads every archived mail of one source and replaces stored
// bodies the current parser reads better — mail whose body was imported as a
// content-free plain stub before body() learned to prefer the HTML part.
//
// It is the one operation allowed past the rule that a re-import never
// rewrites a body, and it is narrow on purpose: only the body column, only
// when the re-parsed text is strictly longer, and only for messages the raw
// still identifies. Attachments, threading and sent_at are left alone — a
// replay through the importer covers those, and this pass is not it.
//
// apply is what separates a report from a write. onHeal, when set, is called
// for every message that would be or was healed, so a long run prints as it
// goes instead of at the end.
func HealBodies(ctx context.Context, st *store.Store, archiveDir, source string, apply bool, onHeal func(BodyHeal)) (HealResult, error) {
	res := HealResult{Applied: apply}
	if err := archive.ValidSource(source); err != nil {
		return res, err
	}
	entries, err := archive.List(archiveDir, source)
	if err != nil {
		return res, err
	}
	for _, e := range entries {
		mbox, ok := mailRaw(e.Ref)
		if !ok {
			continue
		}
		res.Files++
		if err := healFile(ctx, st, source, filepath.Join(archiveDir, e.Ref), e.Ref, mbox, apply, onHeal, &res); err != nil {
			return res, err
		}
	}
	return res, nil
}

// mailRaw reports whether an archived raw is mail this pass can read, and
// whether it is a container of several messages. Anything else under the
// source — a WhatsApp zip that shares a source name, a JSON drop — is skipped
// rather than guessed at.
func mailRaw(ref string) (mbox bool, ok bool) {
	switch strings.ToLower(filepath.Ext(ref)) {
	case ".mbox":
		return true, true
	case ".eml":
		return false, true
	}
	return false, false
}

func healFile(ctx context.Context, st *store.Store, source, path, ref string, mbox, apply bool, onHeal func(BodyHeal), res *HealResult) error {
	one := func(raw []byte) error {
		return healMessage(ctx, st, source, ref, raw, apply, onHeal, res)
	}
	if !mbox {
		raw, err := os.ReadFile(path)
		if err != nil {
			return fail.Opf("read %s: %w", ref, err)
		}
		return one(raw)
	}
	f, err := os.Open(path)
	if err != nil {
		return fail.Opf("read %s: %w", ref, err)
	}
	defer f.Close()
	if err := SplitMbox(f, one); err != nil {
		return fail.Opf("read %s: %w", ref, err)
	}
	return nil
}

func healMessage(ctx context.Context, st *store.Store, source, ref string, raw []byte, apply bool, onHeal func(BodyHeal), res *HealResult) error {
	res.Messages++
	m, err := Parse(raw)
	if err != nil {
		res.Rejected++
		return nil
	}
	id, err := findArchived(ctx, st, source, m, raw)
	if err != nil {
		return fail.Opf("look up message %q: %w", m.MessageID, err)
	}
	if id == 0 {
		return nil
	}
	res.Matched++
	stored, err := st.MessageBody(ctx, id)
	if err != nil {
		return fail.Opf("read body of message %d: %w", id, err)
	}
	h := BodyHeal{
		ID:       id,
		Ref:      ref,
		Subject:  m.Subject,
		Stored:   store.TrimmedBodyLen(stored),
		Reparsed: store.TrimmedBodyLen(m.Body),
	}
	if h.Reparsed <= h.Stored {
		return nil
	}
	if apply {
		if h.Applied, err = st.SetLongerMessageBody(ctx, id, m.Body); err != nil {
			return fail.Opf("heal body of message %d: %w", id, err)
		}
		if !h.Applied {
			return nil
		}
	}
	res.Healed++
	if onHeal != nil {
		onHeal(h)
	}
	return nil
}

// findArchived resolves the row an archived mail belongs to under the identity
// the importer keyed it by: the RFC 822 Message-ID across id schemes first,
// then the external id Ingest would have inserted it under.
func findArchived(ctx context.Context, st *store.Store, source string, m *Message, raw []byte) (int64, error) {
	id, err := st.FindByEmailMessageID(ctx, source, m.MessageID)
	if err != nil || id != 0 {
		return id, err
	}
	return st.FindMessageID(ctx, source, defaultExternalID(m, raw))
}
