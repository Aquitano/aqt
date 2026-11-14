package store

import (
	"context"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
)

// Mail is what an email adds to its message: the reply headers its thread is
// derived from, and the folder it was seen in.
type Mail struct {
	HeaderID   string
	InReplyTo  []string
	References []string
	Mailbox    *MailboxObservation
}

// threadMail records the mail of the written messages. A message that arrived
// with a provider thread keeps it. Any other new mail joins every
// header-derived thread of its source that shares a Message-ID with it: its
// own, or one it names in In-Reply-To or References. When it links several,
// the smallest id wins and the others are relabelled, so mail groups the same
// whatever order it arrives in.
func threadMail(ctx context.Context, tx pgx.Tx, messages []Message, records []Record, out []Written) error {
	var sources []string
	for i, r := range records {
		if r.Mail != nil && out[i].Inserted && messages[i].ThreadID == "" {
			sources = append(sources, messages[i].Source)
		}
	}
	slices.Sort(sources)
	for _, source := range slices.Compact(sources) {
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended('mail-thread:' || $1, 0))`, source); err != nil {
			return err
		}
	}
	for i, r := range records {
		if r.Mail == nil || out[i].ID == 0 {
			continue
		}
		m := messages[i]
		m.ID = out[i].ID
		if out[i].Inserted {
			if err := insertMail(ctx, tx, m, *r.Mail); err != nil {
				return err
			}
		}
		if err := persistMailboxObservation(ctx, tx, m, r.Mail.Mailbox); err != nil {
			return err
		}
	}
	return nil
}

func insertMail(ctx context.Context, tx pgx.Tx, m Message, mail Mail) error {
	native := m.ThreadID != ""
	if !native {
		thread, err := joinThread(ctx, tx, m, mail)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `update messages set thread_id = $2 where id = $1`, m.ID, thread); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `insert into mail_details (message_id, source, header_id, in_reply_to, reference_ids, native)
		values ($1, $2, $3, $4, $5, $6)`, m.ID, m.Source, mail.HeaderID, nonNil(mail.InReplyTo), nonNil(mail.References), native)
	return err
}

func joinThread(ctx context.Context, tx pgx.Tx, m Message, mail Mail) (string, error) {
	ids := slices.Concat(mail.InReplyTo, mail.References)
	if mail.HeaderID != "" {
		ids = append(ids, mail.HeaderID)
	}
	rows, err := tx.Query(ctx, `select distinct m.thread_id from mail_details d join messages m on m.id = d.message_id
		where d.source = $1 and not d.native and (d.header_id = any($2) or d.reply_ids && $2::text[])
		order by 1`, m.Source, ids)
	if err != nil {
		return "", err
	}
	threads, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	if len(threads) == 0 {
		return "mail:" + fieldhash.Hex(m.Source, threadRoot(m, mail)), nil
	}
	if len(threads) > 1 {
		if _, err := tx.Exec(ctx, `update messages set thread_id = $2 where source = $1 and thread_id = any($3)`,
			m.Source, threads[0], threads[1:]); err != nil {
			return "", err
		}
	}
	return threads[0], nil
}

// threadRoot names the conversation a mail starts or answers. Replies carry
// its first message at the head of References, so a thread's id is usually
// the same whichever of its mails arrives first.
func threadRoot(m Message, mail Mail) string {
	switch {
	case len(mail.References) > 0:
		return mail.References[0]
	case len(mail.InReplyTo) > 0:
		return mail.InReplyTo[0]
	case mail.HeaderID != "":
		return mail.HeaderID
	}
	return m.Ref
}
