package store

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

type Mailbox struct {
	ID     int64  `json:"id"`
	Source string `json:"source"`
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	Count  int64  `json:"n"`
}

// MailboxObservation is the folder a mail was seen in during one import, and
// for Gmail over IMAP the labels it carried.
type MailboxObservation struct {
	Kind  string
	Paths []string
}

func (o MailboxObservation) Validate() error {
	if o.Kind != "export" && o.Kind != "imap" {
		return fmt.Errorf("mailbox kind must be export or imap")
	}
	if len(o.Paths) == 0 {
		return fmt.Errorf("mailbox observation needs a folder")
	}
	for _, path := range o.Paths {
		if path == "" || len(path) > 4096 || !utf8.ValidString(path) || strings.ContainsAny(path, "\x00\r\n") {
			return fmt.Errorf("invalid mailbox path %q", path)
		}
	}
	return nil
}

type MailProvenance struct {
	MessageID  string   `json:"message_id"`
	InReplyTo  []string `json:"in_reply_to"`
	References []string `json:"references"`
	Native     bool     `json:"native" doc:"The thread id came from the provider (Gmail), not from reply headers."`
}

func (s *Store) loadMailProvenance(ctx context.Context, messages []MessageDetail) error {
	ids := make([]int64, len(messages))
	positions := make(map[int64]int, len(messages))
	for index, message := range messages {
		ids[index], positions[message.ID] = message.ID, index
	}
	rows, err := s.pool.Query(ctx, `select message_id, header_id, in_reply_to, reference_ids, native
		from mail_details where message_id = any($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var provenance MailProvenance
		if err := rows.Scan(&id, &provenance.MessageID, &provenance.InReplyTo, &provenance.References, &provenance.Native); err != nil {
			return err
		}
		messages[positions[id]].Mail = &provenance
	}
	return rows.Err()
}

func (s *Store) ResolveMailMessage(ctx context.Context, source, messageID, externalID string) (int64, error) {
	id, err := s.FindByEmailMessageID(ctx, source, messageID)
	if err != nil || id != 0 {
		return id, err
	}
	return s.FindMessageID(ctx, source, externalID)
}

func (s *Store) ListMailboxes(ctx context.Context, source string) ([]Mailbox, error) {
	if err := ingest.ValidSource(source); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `select b.id,b.source,b.kind,b.path,count(m.message_id)
		from mailboxes b left join mailbox_messages m on m.mailbox_id=b.id
		where b.source=$1 group by b.id order by b.kind,b.path,b.id`, source)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	mailboxes := []Mailbox{}
	for rows.Next() {
		var mailbox Mailbox
		if err := rows.Scan(&mailbox.ID, &mailbox.Source, &mailbox.Kind, &mailbox.Path, &mailbox.Count); err != nil {
			return nil, err
		}
		mailboxes = append(mailboxes, mailbox)
	}
	return mailboxes, rows.Err()
}

func (s *Store) validateMailbox(ctx context.Context, source string, id int64) error {
	if id == 0 {
		return nil
	}
	var valid bool
	if err := s.pool.QueryRow(ctx, `select exists(select 1 from mailboxes where id=$1 and source=$2)`, id, source).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrMailboxSource
	}
	return nil
}

var ErrMailboxSource = fmt.Errorf("mailbox does not belong to the selected source")

func mailPredicates(m string, mailboxID int64, subject string, hasAttachment *bool, next func(any) string) string {
	query := ""
	if mailboxID != 0 {
		query += " and exists(select 1 from mailbox_messages membership where membership.message_id=" + m + ".id and membership.mailbox_id=" + next(mailboxID) + ")"
	}
	if subject != "" {
		query += " and strpos(lower(" + m + ".subject),lower(" + next(subject) + ")) > 0"
	}
	if hasAttachment != nil {
		query += " and exists(select 1 from attachments attachment where attachment.message_id=" + m + ".id) = " + next(*hasAttachment)
	}
	return query
}

func (s *Store) loadMailboxes(ctx context.Context, messages []MessageDetail) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]int64, len(messages))
	positions := make(map[int64]int, len(messages))
	for index, message := range messages {
		ids[index], positions[message.ID] = message.ID, index
	}
	rows, err := s.pool.Query(ctx, `select membership.message_id,b.id,b.source,b.kind,b.path
		from mailbox_messages membership join mailboxes b on b.id=membership.mailbox_id
		where membership.message_id=any($1) order by b.kind,b.path,b.id`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID int64
		var mailbox Mailbox
		if err := rows.Scan(&messageID, &mailbox.ID, &mailbox.Source, &mailbox.Kind, &mailbox.Path); err != nil {
			return err
		}
		messages[positions[messageID]].Mailboxes = append(messages[positions[messageID]].Mailboxes, mailbox)
	}
	return rows.Err()
}

func persistMailboxObservation(ctx context.Context, tx pgx.Tx, message Message, observation *MailboxObservation) error {
	if observation == nil {
		return nil
	}
	paths := append([]string{}, observation.Paths...)
	for i, path := range paths {
		if observation.Kind == "imap" && strings.EqualFold(path, "INBOX") {
			paths[i] = "INBOX"
		}
	}
	if _, err := tx.Exec(ctx, `insert into mailboxes(source,kind,path)
		select $1,$2,wanted.path from unnest($3::text[]) wanted(path)
		where not exists(select 1 from mailboxes m where m.source=$1 and m.kind=$2 and m.path=wanted.path)
		on conflict(source,kind,path) do nothing`, message.Source, observation.Kind, paths); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `insert into mailbox_messages(mailbox_id,message_id)
		select m.id,$4 from mailboxes m where m.source=$1 and m.kind=$2 and m.path=any($3)
		on conflict do nothing`, message.Source, observation.Kind, paths, message.ID)
	return err
}
