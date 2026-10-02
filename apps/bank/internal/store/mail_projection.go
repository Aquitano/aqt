package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

func persistMailFacts(ctx context.Context, transaction pgx.Tx, message Message, key string, projection MailProjection, edges []mailEdge, incomplete bool) error {
	keys := map[string]bool{key: true}
	for _, edge := range edges {
		keys[edge.Left], keys[edge.Right] = true, true
	}
	batch := &pgx.Batch{}
	for node := range keys {
		batch.Queue(`insert into mail_thread_nodes(source,node_key) values($1,$2) on conflict do nothing`, message.Source, node)
	}
	if err := transaction.SendBatch(ctx, batch).Close(); err != nil {
		return err
	}
	if projection.InReplyTo == nil {
		projection.InReplyTo = []string{}
	}
	if projection.References == nil {
		projection.References = []string{}
	}
	if _, err := transaction.Exec(ctx, `insert into mail_details(message_id,source,node_key,in_reply_to,reference_ids,native_thread_id,incomplete,header_message_id,header_raw_ref)
		values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(message_id) do update set node_key=excluded.node_key,
		in_reply_to=excluded.in_reply_to,reference_ids=excluded.reference_ids,native_thread_id=excluded.native_thread_id,incomplete=excluded.incomplete,
		header_message_id=excluded.header_message_id,header_raw_ref=excluded.header_raw_ref`,
		message.ID, message.Source, key, projection.InReplyTo, projection.References, projection.NativeThreadID, incomplete, projection.MessageID, projection.RawRef); err != nil {
		return err
	}
	if incomplete {
		return persistMailboxObservation(ctx, transaction, message, projection)
	}
	if _, err := transaction.Exec(ctx, `delete from mail_thread_edges where source=$1 and owner_id=$2`, message.Source, message.ID); err != nil {
		return err
	}
	batch = &pgx.Batch{}
	for _, edge := range edges {
		batch.Queue(`insert into mail_thread_edges(source,owner_id,left_node,right_node) values($1,$2,$3,$4) on conflict do nothing`, message.Source, message.ID, edge.Left, edge.Right)
	}
	if err := transaction.SendBatch(ctx, batch).Close(); err != nil {
		return err
	}
	return persistMailboxObservation(ctx, transaction, message, projection)
}

func persistMailboxObservation(ctx context.Context, transaction pgx.Tx, message Message, projection MailProjection) error {
	if projection.Context != nil {
		observation := *projection.Context
		if observation.Kind == "imap" && strings.EqualFold(observation.Mailbox, "INBOX") {
			observation.Mailbox = "INBOX"
		}
		var mailboxID int64
		if err := transaction.QueryRow(ctx, `insert into mailboxes(source,kind,path) values($1,$2,$3)
			on conflict(source,kind,path) do update set path=excluded.path returning id`, message.Source, observation.Kind, observation.Mailbox).Scan(&mailboxID); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `insert into mailbox_messages(mailbox_id,message_id) values($1,$2) on conflict do nothing`, mailboxID, message.ID); err != nil {
			return err
		}
	}
	return nil
}

func persistMailComponents(ctx context.Context, transaction pgx.Tx, source string, components []mailComponent, history []mailHistory) error {
	for _, component := range components {
		if _, err := transaction.Exec(ctx, `update mail_thread_nodes set thread_id=$3,conflict_key=$4 where source=$1 and node_key=any($2)`, source, component.Keys, component.ThreadID, component.Conflict); err != nil {
			return err
		}
		if _, err := transaction.Exec(ctx, `update messages m set thread_id=case when $4<>'' then d.native_thread_id else $3 end
			from mail_details d where d.message_id=m.id and d.source=$1 and d.node_key=any($2)`, source, component.Keys, component.ThreadID, component.Conflict); err != nil {
			return err
		}
		batch := &pgx.Batch{}
		for _, key := range component.Keys {
			batch.Queue(`insert into mail_thread_aliases(source,old_id,current_id,conflict_key)
				select $1,$2,nullif($3,''),nullif($4,'') where not exists(select 1 from mail_details where source=$1 and native_thread_id=$2)
				on conflict(source,old_id) do update set current_id=excluded.current_id,conflict_key=excluded.conflict_key`, source, mailDerivedID(key), component.ThreadID, component.Conflict)
		}
		if err := transaction.SendBatch(ctx, batch).Close(); err != nil {
			return err
		}
	}
	return persistMailHistory(ctx, transaction, source, history)
}
