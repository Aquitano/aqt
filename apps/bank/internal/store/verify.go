package store

import (
	"context"
	"database/sql"
)

// ArchivedMessage is what an integrity check needs about one message: where
// its raw input was filed and which attachment rows claim to exist.
type ArchivedMessage struct {
	ID          int64
	Source      string
	RawRef      string
	Subject     string
	Attachments []Attachment
}

// EachArchivedMessage streams every message, oldest id first, with its
// attachments already grouped. One ordered join keeps a whole-archive walk to
// a single query instead of one per message.
func (s *Store) EachArchivedMessage(ctx context.Context, source string, fn func(ArchivedMessage) error) error {
	query := `
		select m.id, m.source, m.raw_ref, m.subject,
		       a.id, a.filename, a.mime_type, a.size_bytes, a.sha256
		from messages m
		left join attachments a on a.message_id = m.id`
	var args []any
	if source != "" {
		query += " where m.source = $1"
		args = append(args, source)
	}
	query += " order by m.id, a.id"

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	var cur ArchivedMessage
	flush := func() error {
		if cur.ID == 0 {
			return nil
		}
		return fn(cur)
	}
	for rows.Next() {
		var m ArchivedMessage
		var (
			attID, size             sql.NullInt64
			filename, mimeType, sha sql.NullString
		)
		if err := rows.Scan(&m.ID, &m.Source, &m.RawRef, &m.Subject,
			&attID, &filename, &mimeType, &size, &sha); err != nil {
			return err
		}
		if m.ID != cur.ID {
			if err := flush(); err != nil {
				return err
			}
			cur = m
		}
		if attID.Valid {
			cur.Attachments = append(cur.Attachments, Attachment{
				ID:        attID.Int64,
				MessageID: cur.ID,
				Filename:  filename.String,
				MimeType:  mimeType.String,
				SizeBytes: size.Int64,
				SHA256:    sha.String,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return flush()
}

// SetAttachmentSize corrects a size_bytes that disagrees with bytes whose
// digest still matches — the one repair that needs no raw input.
func (s *Store) SetAttachmentSize(ctx context.Context, id, size int64) error {
	_, err := s.pool.Exec(ctx, `update attachments set size_bytes = $2 where id = $1`, id, size)
	return err
}

type ArchivedLibraryRecord struct {
	ID        string
	Kind      string
	RawRefs   []string
	Snapshot  string
	SHA256    string
	SizeBytes int64
}

func (s *Store) EachArchivedLibraryRecord(ctx context.Context, source string, fn func(ArchivedLibraryRecord) error) error {
	rows, err := s.pool.Query(ctx, `
  select id,kind,raw_refs,snapshot,sha256,size_bytes from (
   select i.id,'item' as kind,i.source,array(select distinct ref from (select coalesce(i.provenance->>'raw_ref','') as ref union select e.raw_ref from library_item_evidence e where e.item_id=i.id) evidence where ref<>'') as raw_refs,'' as snapshot,'' as sha256,0::bigint as size_bytes from library_items i
   union all select a.id,'activity',a.source,array(select distinct ref from (select coalesce(a.provenance->>'raw_ref','') as ref union select e.raw_ref from library_activity_evidence e where e.activity_id=a.id) evidence where ref<>''),'','',0::bigint from library_activity a
   union all select c.id,'collection',c.source,array[coalesce(s.provenance->>'raw_ref','')],s.external_id,'',0::bigint from library_snapshots s join library_collections c on c.id=s.collection_id
   union all select id,'file',source,array[coalesce(provenance->>'raw_ref','')],'',sha256,size_bytes from library_files
   union all select id,'page',source,array[coalesce(provenance->>'raw_ref','')],'','',0::bigint from library_pages
  ) records where ($1='' or source=$1) order by kind,id,snapshot`, source)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var record ArchivedLibraryRecord
		if err := rows.Scan(&record.ID, &record.Kind, &record.RawRefs, &record.Snapshot, &record.SHA256, &record.SizeBytes); err != nil {
			return err
		}
		if err := fn(record); err != nil {
			return err
		}
	}
	return rows.Err()
}
