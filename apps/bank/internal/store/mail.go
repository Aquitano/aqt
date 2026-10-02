package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
)

type Mailbox struct {
	ID     int64  `json:"id"`
	Source string `json:"source"`
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	Count  int64  `json:"n"`
}

func (s *Store) ResolveMailMessage(ctx context.Context, source, messageID, externalID string) (int64, error) {
	id, err := s.FindByEmailMessageID(ctx, source, messageID)
	if err != nil || id != 0 {
		return id, err
	}
	return s.FindMessageID(ctx, source, externalID)
}

func (s *Store) ObserveMailbox(ctx context.Context, messageID int64, observation archive.MailImportContext) error {
	if err := observation.Validate(); err != nil {
		return err
	}
	if observation.Kind == "imap" && strings.EqualFold(observation.Mailbox, "INBOX") {
		observation.Mailbox = "INBOX"
	}
	transaction, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var source string
	if err := transaction.QueryRow(ctx, `select source from messages where id=$1 for update`, messageID).Scan(&source); err != nil {
		return err
	}
	var mailboxID int64
	if err := transaction.QueryRow(ctx, `insert into mailboxes(source,kind,path) values($1,$2,$3)
		on conflict(source,kind,path) do update set path=excluded.path returning id`, source, observation.Kind, observation.Mailbox).Scan(&mailboxID); err != nil {
		return err
	}
	if _, err := transaction.Exec(ctx, `insert into mailbox_messages(mailbox_id,message_id) values($1,$2) on conflict do nothing`, mailboxID, messageID); err != nil {
		return err
	}
	return transaction.Commit(ctx)
}

func (s *Store) ListMailboxes(ctx context.Context, source string) ([]Mailbox, error) {
	if err := archive.ValidSource(source); err != nil {
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

func mailPredicates(mailboxID int64, subject string, hasAttachment *bool, next func(any) string) string {
	query := ""
	if mailboxID != 0 {
		query += " and exists(select 1 from mailbox_messages membership where membership.message_id=m.id and membership.mailbox_id=" + next(mailboxID) + ")"
	}
	if subject != "" {
		query += " and strpos(lower(m.subject),lower(" + next(subject) + ")) > 0"
	}
	if hasAttachment != nil {
		query += " and exists(select 1 from attachments attachment where attachment.message_id=m.id) = " + next(*hasAttachment)
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
