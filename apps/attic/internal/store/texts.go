package store

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

// PendingText is a hashed document below the scan root whose content has no
// text yet.
type PendingText struct {
	ID        int64
	Path      string
	Name      string
	ContentID int64
	Size      int64
	Digest    disk.Digest
}

// pendingTextWhere selects documents by extension below an upper path bound;
// the callers add the lower one as $4.
const pendingTextWhere = `
	from entries e join contents c on c.id = e.content_id
	where e.volume_id = $1 and e.kind = 'file' and e.hash_state = 'done' and e.missing_scan is null
	  and e.ext = any($2) and not exists (select 1 from texts t where t.content_id = e.content_id)
	  and ($3 = '' or e.path collate "C" < $3)`

// TextTotals is the reading work left below the scan root, one per content.
func (sc *Scan) TextTotals(ctx context.Context, exts []string) (int64, error) {
	lower, upper := sc.subtree()
	var n int64
	err := sc.store.pool.QueryRow(ctx, `select count(distinct e.content_id)`+pendingTextWhere+` and e.path collate "C" > $4`,
		sc.Volume.ID, exts, upper, lower).Scan(&n)
	return n, err
}

// NextTexts returns up to limit documents after the given one, in path order.
// Copies of one content can both come back; the first read settles the other.
func (sc *Scan) NextTexts(ctx context.Context, after PendingText, exts []string, limit int) ([]PendingText, error) {
	lower, upper := sc.subtree()
	if after.ID != 0 {
		lower = after.Path
	}
	rows, err := sc.store.pool.Query(ctx, `select e.id, e.path, e.name, e.content_id, c.size_bytes, c.blake3`+pendingTextWhere+`
		  and (e.path collate "C", e.id) > ($4, $5)
		order by e.path collate "C", e.id limit $6`,
		sc.Volume.ID, exts, upper, lower, after.ID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (PendingText, error) {
		var p PendingText
		var digest []byte
		err := r.Scan(&p.ID, &p.Path, &p.Name, &p.ContentID, &p.Size, &digest)
		copy(p.Digest[:], digest)
		return p, err
	})
}

// DocumentText is what reading one document found.
type DocumentText struct {
	Status    string
	Extractor string
	Detail    string
	Text      string
}

// SetText records a document's text against its content. A copy of the same
// content read in the meantime, by this scan or another, keeps its row.
//
// The row commits on its own, as SetContent's does: held in the scan's
// transaction while the next document is read, it would block a scan of
// another disk meeting the same content, and two such scans could deadlock.
func (sc *Scan) SetText(ctx context.Context, contentID int64, t DocumentText) error {
	tx, err := sc.store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if err := lockContentCache(ctx, tx, true); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `insert into texts (content_id, status, extractor, detail, text) values ($1, $2, $3, $4, $5)
		on conflict do nothing`, contentID, t.Status, t.Extractor, cleanText(t.Detail), cleanText(t.Text))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		sc.Counts.Texts++
		sc.Counts.TextChars += int64(utf8.RuneCountInString(t.Text))
	}
	return nil
}

// TextHit is a document whose text matches, with the places its content
// lives, present copies first.
type TextHit struct {
	Ref     string  `json:"ref"`
	Snippet string  `json:"snippet"`
	Score   float64 `json:"score,omitempty"`
	Places  []Hit   `json:"places"`
}

// SearchTexts finds documents whose text holds the words. The filters apply
// to where a copy lives and what it is named; folders hold no text.
func (s *Store) SearchTexts(ctx context.Context, o SearchOptions) ([]TextHit, error) {
	return s.searchTextTable(ctx, o, "texts")
}

// table is a package-owned literal; never a query parameter.
func (s *Store) searchTextTable(ctx context.Context, o SearchOptions, table string) ([]TextHit, error) {
	words := strings.Fields(o.Query)
	if len(words) == 0 || (o.Kind != "" && o.Kind != "file") {
		return nil, nil
	}
	q := &search{}
	clauses := make([]string, len(words))
	for i, w := range words {
		clauses[i] = "paradedb.match('text', " + q.next(w) + ")"
	}
	mode := "must"
	if o.Any {
		mode = "should"
	}
	q.where = append(q.where, "t.content_id @@@ paradedb.boolean("+mode+" => array["+strings.Join(clauses, ", ")+"])")
	// Text outlives a file that was rewritten; only contents some entry still
	// has are found.
	place := []string{"e.content_id = t.content_id"}
	if o.VolumeID != "" {
		place = append(place, "e.volume_id = "+q.next(o.VolumeID))
	}
	if o.Under != "" {
		under := strings.TrimSuffix(o.Under, "/")
		place = append(place, `e.path collate "C" > `+q.next(under+"/")+` and e.path collate "C" < `+q.next(under+"0"))
	}
	if o.Ext != "" {
		place = append(place, "e.ext = "+q.next(strings.ToLower(strings.TrimPrefix(o.Ext, "."))))
	}
	q.where = append(q.where, `exists (select 1 from entries e where `+strings.Join(place, " and ")+`)`)
	q.order = "paradedb.score(t.content_id) desc, t.content_id"
	rows, err := s.pool.Query(ctx, `select t.content_id, `+refSQL+`, paradedb.score(t.content_id),
		paradedb.snippet(t.text, start_tag => '', end_tag => '', max_num_chars => 200)
		from `+table+` t join contents c on c.id = t.content_id`+q.tail(o), q.args...)
	if err != nil {
		return nil, err
	}
	var ids []int64
	hits, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (TextHit, error) {
		var h TextHit
		var id int64
		var score float32
		var snippet *string
		err := r.Scan(&id, &h.Ref, &score, &snippet)
		h.Score = float64(score)
		if snippet != nil {
			h.Snippet = html.UnescapeString(*snippet)
		}
		ids = append(ids, id)
		return h, err
	})
	if err != nil {
		return nil, err
	}
	places, err := s.occurrencesMany(ctx, ids, 0, false, copiesOf(o, false))
	if err != nil {
		return nil, err
	}
	for i, id := range ids {
		hits[i].Places = places[id]
	}
	return hits, nil
}

// TextInfo is a document's reading outcome without the text.
type TextInfo struct {
	Status    string    `json:"status"`
	Extractor string    `json:"extractor,omitempty"`
	Detail    string    `json:"detail,omitempty"`
	Chars     int64     `json:"chars"`
	Extracted time.Time `json:"extracted"`
}

func (s *Store) textInfo(ctx context.Context, contentID int64) (*TextInfo, error) {
	var t TextInfo
	err := s.pool.QueryRow(ctx, `select status, extractor, detail, chars, extracted_at
		from texts where content_id = $1`, contentID).Scan(&t.Status, &t.Extractor, &t.Detail, &t.Chars, &t.Extracted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &t, err
}

// TextDetail is a document's text, for `attic text`.
type TextDetail struct {
	Ref string `json:"ref"`
	TextInfo
	Text string `json:"text"`
}

// Text returns the text read from an entry's content, or from a ref's.
func (s *Store) Text(ctx context.Context, entryID int64, ref string) (TextDetail, error) {
	var d TextDetail
	var prefix []byte
	if entryID == 0 {
		r, ok := ParseRef(ref)
		if !ok {
			return d, fmt.Errorf("not a ref: %q", ref)
		}
		prefix, _ = hex.DecodeString(r)
	}
	err := s.pool.QueryRow(ctx, `select `+refSQL+`, t.status, t.extractor, t.detail, t.chars, t.extracted_at, t.text
		from texts t join contents c on c.id = t.content_id
		where ($1::bigint <> 0 and c.id = (select content_id from entries where id = $1))
		   or ($1::bigint = 0 and substr(c.blake3, 1, 8) = $2)
		order by c.id limit 1`, entryID, prefix).
		Scan(&d.Ref, &d.Status, &d.Extractor, &d.Detail, &d.Chars, &d.Extracted, &d.Text)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, fmt.Errorf("no text read for that file: %w", ErrNotFound)
	}
	return d, err
}
