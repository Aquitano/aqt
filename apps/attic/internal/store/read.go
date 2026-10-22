package store

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// RefChars is how much of a BLAKE3 digest a ref keeps. At five million
// contents twelve characters would give about a 4% chance of two sharing one;
// sixteen make it negligible.
const RefChars = 16

const refSQL = `encode(substr(c.blake3, 1, 8), 'hex')`

// ParseRef accepts a ref as typed or as cited ("attic:3f9a..."), in either
// case, and rejects anything else before it reaches a query.
func ParseRef(s string) (string, bool) {
	s = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "attic:"))
	_, err := hex.DecodeString(s)
	return s, len(s) == RefChars && err == nil
}

type contentLookup struct {
	entryID int64
	prefix  []byte
}

const contentLookupWhere = `(($1::bigint <> 0 and c.id = (select content_id from entries where id = $1))
 or ($1::bigint = 0 and substr(c.blake3, 1, 8) = $2))`

func newContentLookup(entryID int64, ref string) (contentLookup, error) {
	lookup := contentLookup{entryID: entryID}
	if entryID != 0 {
		return lookup, nil
	}
	parsed, ok := ParseRef(ref)
	if !ok {
		return lookup, fmt.Errorf("not a ref: %q", ref)
	}
	lookup.prefix, _ = hex.DecodeString(parsed)
	return lookup, nil
}

// Hit is one entry as search, show and dupes print it.
type Hit struct {
	ID       int64      `json:"id"`
	VolumeID string     `json:"volume_id"`
	Volume   string     `json:"volume"`
	Kind     string     `json:"kind"`
	Path     string     `json:"path"`
	Size     int64      `json:"size"`
	Modified *time.Time `json:"modified,omitempty"`
	Ref      string     `json:"ref,omitempty"`
	Missing  bool       `json:"missing,omitempty"`
	Score    float64    `json:"score,omitempty"`
}

const hitColumns = `e.id, e.volume_id::text, v.label, e.kind, e.path, e.size_bytes, e.modified_at,
	e.missing_scan is not null as missing, coalesce(` + refSQL + `, '')`

const hitFrom = ` from entries e join volumes v on v.id = e.volume_id left join contents c on c.id = e.content_id`

func scanHit(row pgx.Row, extra ...any) (Hit, error) {
	var h Hit
	dest := append([]any{&h.ID, &h.VolumeID, &h.Volume, &h.Kind, &h.Path, &h.Size, &h.Modified, &h.Missing, &h.Ref}, extra...)
	err := row.Scan(dest...)
	return h, err
}

type SearchOptions struct {
	Query string
	// Any matches entries containing any word; the default needs every word,
	// each in the name, the path or as a fragment of the name.
	Any      bool
	VolumeID string
	Ext      string
	Kind     string
	// Under restricts to a folder, volume-relative; it needs VolumeID.
	Under  string
	Limit  int
	Offset int
}

// Search ranks name matches above path matches above name fragments. A query
// with no text lists whatever the filters select, in path order. Pieces with
// no indexed terms are ignored; if none remain, the query matches nothing.
func (s *Store) Search(ctx context.Context, o SearchOptions) ([]Hit, error) {
	q, err := s.newSearch(ctx, o, "e")
	if err != nil {
		return nil, err
	}
	q.where = append(q.where, q.entryFilters(copiesOf(o, false))...)
	rows, err := s.pool.Query(ctx, `select `+hitColumns+`, `+q.score+hitFrom+q.tail(o), q.args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Hit, error) {
		var score float32
		h, err := scanHit(r, &score)
		h.Score = float64(score)
		return h, err
	})
}

// search holds what entries and members share: the words, the ext and kind
// filters, the order and the page. Both BM25 indexes have the same fields.
type search struct {
	args         []any
	where        []string
	score, order string
}

func (s *Store) newSearch(ctx context.Context, o SearchOptions, alias string) (*search, error) {
	words := strings.Fields(o.Query)
	switch {
	case len(words) == 0 && o.VolumeID == "" && o.Ext == "" && o.Kind == "" && o.Under == "":
		return nil, errors.New("search needs words or a filter")
	case o.Under != "" && o.VolumeID == "":
		return nil, errors.New("--under needs a volume")
	}
	words, err := s.searchWords(ctx, words, true)
	if err != nil {
		return nil, err
	}
	q := &search{score: "0::real", order: alias + `.path collate "C", ` + alias + ".id"}
	if len(words) == 0 && strings.TrimSpace(o.Query) != "" {
		q.where = append(q.where, "false")
	}
	if len(words) > 0 {
		q.where = append(q.where, alias+".id @@@ "+searchPredicate(words, o.Any, q.next))
		q.score = "paradedb.score(" + alias + ".id)"
		q.order = q.score + " desc, " + q.order
	}
	if o.Kind != "" {
		q.where = append(q.where, alias+".kind = "+q.next(o.Kind))
	}
	return q, nil
}

func (q *search) next(v any) string {
	q.args = append(q.args, v)
	return "$" + strconv.Itoa(len(q.args))
}

func (q *search) tail(o SearchOptions) string {
	limit := o.Limit
	if limit <= 0 {
		limit = 20
	}
	return ` where ` + strings.Join(q.where, " and ") + ` order by ` + q.order +
		` limit ` + q.next(limit) + ` offset ` + q.next(o.Offset)
}

// MemberHit is a file or folder inside an archive, with the places the
// archive lives, present copies first.
type MemberHit struct {
	ID        int64      `json:"id"`
	Kind      string     `json:"kind"`
	Path      string     `json:"path"`
	Size      int64      `json:"size"`
	Modified  *time.Time `json:"modified,omitempty"`
	CRC32     string     `json:"crc32,omitempty"`
	Encrypted bool       `json:"encrypted,omitempty"`
	Score     float64    `json:"score,omitempty"`
	Archive   []Hit      `json:"archive"`
}

// SearchMembers finds files inside archives with the words and filters of
// Search. The volume and the folder filter where the archive lives; a folder
// that is the archive itself selects its members.
func (s *Store) SearchMembers(ctx context.Context, o SearchOptions) ([]MemberHit, error) {
	q, err := s.newSearch(ctx, o, "m")
	if err != nil {
		return nil, err
	}
	// A listing outlives an archive file that was rewritten; only contents some
	// entry still has are found.
	place := []string{"e.content_id = m.archive_id"}
	place = append(place, q.entryFilters(copiesOf(o, true))...)
	if o.Ext != "" {
		q.where = append(q.where, "m.ext = "+q.next(searchExt(o.Ext)))
	}
	q.where = append(q.where, `exists (select 1 from entries e where `+strings.Join(place, " and ")+`)`)
	rows, err := s.pool.Query(ctx, `select m.id, m.kind, m.path, m.size_bytes, m.modified_at, m.crc32, m.encrypted,
		m.archive_id, `+q.score+` from members m`+q.tail(o), q.args...)
	if err != nil {
		return nil, err
	}
	var archiveIDs []int64
	hits, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (MemberHit, error) {
		var h MemberHit
		var crc *int64
		var archiveID int64
		var score float32
		err := r.Scan(&h.ID, &h.Kind, &h.Path, &h.Size, &h.Modified, &crc, &h.Encrypted, &archiveID, &score)
		if crc != nil {
			h.CRC32 = fmt.Sprintf("%08x", *crc)
		}
		h.Score = float64(score)
		archiveIDs = append(archiveIDs, archiveID)
		return h, err
	})
	if err != nil {
		return nil, err
	}
	places, err := s.occurrencesMany(ctx, archiveIDs, 0, false, copiesOf(o, true))
	if err != nil {
		return nil, err
	}
	for i, id := range archiveIDs {
		hits[i].Archive = places[id]
	}
	return hits, nil
}

// searchPredicate builds one clause per word: the word as a name token
// (weighted 3), as a path token, or, from three characters, as a fragment of
// the name, where every trigram must be present.
func searchPredicate(words []string, any bool, next func(any) string) string {
	clauses := make([]string, 0, len(words))
	for _, w := range words {
		p := next(w)
		parts := []string{
			"paradedb.boost(3, paradedb.match('name', " + p + "))",
			"paradedb.match('path', " + p + ")",
		}
		if utf8.RuneCountInString(w) >= 3 {
			parts = append(parts, "paradedb.match('name_ngram', "+p+", conjunction_mode => true)")
		}
		clauses = append(clauses, "paradedb.boolean(should => array["+strings.Join(parts, ", ")+"])")
	}
	return searchBoolean(clauses, any)
}

// EntryDetail is everything known about one entry, plus the other places its
// content lives.
type EntryDetail struct {
	Hit
	Name       string     `json:"name"`
	FileID     *int64     `json:"file_id,omitempty"`
	Created    *time.Time `json:"created,omitempty"`
	Accessed   *time.Time `json:"accessed,omitempty"`
	Changed    *time.Time `json:"changed,omitempty"`
	Attributes int32      `json:"attributes"`
	HashState  string     `json:"hash_state"`
	GitRemote  *string    `json:"git_remote,omitempty"`
	FirstSeen  time.Time  `json:"first_seen"`
	Updated    time.Time  `json:"updated"`
	Listed     *time.Time `json:"listed,omitempty"`
	MissingAt  *time.Time `json:"missing_since,omitempty"`
	Copies     []Hit      `json:"copies,omitempty"`
	// Archive is set once the entry's content was read as an archive, Text
	// once it was read as a document.
	Archive  *ArchiveInfo    `json:"archive,omitempty"`
	Text     *TextInfo       `json:"text,omitempty"`
	Metadata *MetadataDetail `json:"metadata,omitempty"`
}

type ArchiveInfo struct {
	Format  string `json:"format,omitempty"`
	Status  string `json:"status"`
	Detail  string `json:"detail,omitempty"`
	Members int64  `json:"members"`
}

func (s *Store) Entry(ctx context.Context, id int64) (EntryDetail, error) {
	var d EntryDetail
	var contentID *int64
	h, err := scanHit(s.pool.QueryRow(ctx, `select `+hitColumns+`, e.name, e.file_id, e.created_at, e.accessed_at,
		       e.changed_at, e.attributes, e.hash_state, e.git_remote, e.content_id,
		       (select started_at from scans where id = e.first_scan), (select started_at from scans where id = e.updated_scan),
		       (select started_at from scans where id = e.listed_scan), (select started_at from scans where id = e.missing_scan)`+
		hitFrom+` where e.id = $1`, id),
		&d.Name, &d.FileID, &d.Created, &d.Accessed, &d.Changed, &d.Attributes, &d.HashState, &d.GitRemote, &contentID,
		&d.FirstSeen, &d.Updated, &d.Listed, &d.MissingAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, fmt.Errorf("entry %d: %w", id, ErrNotFound)
	}
	if err != nil {
		return d, err
	}
	d.Hit = h
	if contentID == nil {
		return d, nil
	}
	if d.Copies, err = s.occurrences(ctx, *contentID, id, false, copies{}); err != nil {
		return d, err
	}
	if d.Text, err = s.textInfo(ctx, *contentID); err != nil {
		return d, err
	}
	if m, err := s.Metadata(ctx, id, ""); err == nil {
		d.Metadata = &m
	} else if !errors.Is(err, ErrNotFound) {
		return d, err
	}
	var a ArchiveInfo
	err = s.pool.QueryRow(ctx, `select format, status, detail, members from archives where content_id = $1`, *contentID).
		Scan(&a.Format, &a.Status, &a.Detail, &a.Members)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return d, nil
	case err != nil:
		return d, err
	}
	d.Archive = &a
	return d, nil
}

// ContentDetail is one unique content and every place it lives.
type ContentDetail struct {
	Ref         string    `json:"ref"`
	BLAKE3      string    `json:"blake3"`
	Size        int64     `json:"size"`
	FirstSeen   time.Time `json:"first_seen"`
	Occurrences []Hit     `json:"occurrences"`
}

// Content resolves a ref, the citation form.
func (s *Store) Content(ctx context.Context, ref string) (ContentDetail, error) {
	var d ContentDetail
	ref, ok := ParseRef(ref)
	if !ok {
		return d, fmt.Errorf("not a ref: %q", ref)
	}
	prefix, _ := hex.DecodeString(ref)
	var id int64
	var digest []byte
	err := s.pool.QueryRow(ctx, `select c.id, c.blake3, c.size_bytes, c.first_seen, `+refSQL+`
		from contents c where substr(c.blake3, 1, 8) = $1 order by c.id limit 1`, prefix).
		Scan(&id, &digest, &d.Size, &d.FirstSeen, &d.Ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, fmt.Errorf("ref %s: %w", ref, ErrNotFound)
	}
	if err != nil {
		return d, err
	}
	d.BLAKE3 = hex.EncodeToString(digest)
	d.Occurrences, err = s.occurrences(ctx, id, 0, false, copies{})
	return d, err
}

// copies narrows the places listed for a content. under is a volume-relative
// folder; with self, the path itself counts too, as for an archive named by
// --under.
type copies struct {
	volumes []string
	under   string
	self    bool
	ext     string
}

// copiesOf keeps the places a search shows inside its own filters, so a
// search of E:\Work does not point at the copy in E:\Archive or on F:.
func copiesOf(o SearchOptions, self bool) copies {
	c := copies{under: o.Under, self: self}
	if o.VolumeID != "" {
		c.volumes = []string{o.VolumeID}
	}
	if !self && o.Ext != "" {
		c.ext = searchExt(o.Ext)
	}
	return c
}

// occurrences lists where a content lives, present copies first. presentOnly
// drops missing ones; c narrows them further.
func (s *Store) occurrences(ctx context.Context, contentID, except int64, presentOnly bool, c copies) ([]Hit, error) {
	places, err := s.occurrencesMany(ctx, []int64{contentID}, except, presentOnly, c)
	return places[contentID], err
}

func (s *Store) occurrencesMany(ctx context.Context, ids []int64, except int64, presentOnly bool, c copies) (map[int64][]Hit, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	q := &search{args: []any{ids, except, presentOnly}}
	where := []string{"e.content_id = selected.id", "e.id <> $2", "(not $3 or e.missing_scan is null)"}
	where = append(where, q.entryFilters(c)...)
	rows, err := s.pool.Query(ctx, `select places.* from (select distinct unnest($1::bigint[]) as id) selected
		cross join lateral (select `+hitColumns+`, e.content_id`+hitFrom+`
		where `+strings.Join(where, " and ")+`
		order by e.missing_scan is not null, v.label, e.path collate "C", e.id limit 100) places
		order by places.content_id, places.missing, places.label, places.path collate "C", places.id`, q.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	places := make(map[int64][]Hit)
	for rows.Next() {
		var id int64
		h, err := scanHit(rows, &id)
		if err != nil {
			return nil, err
		}
		places[id] = append(places[id], h)
	}
	return places, rows.Err()
}

// ScanInfo is one scan as `attic scans`, `attic volumes` and `attic skips`
// report it.
type ScanInfo struct {
	ID       int64      `json:"id"`
	VolumeID string     `json:"volume_id"`
	Volume   string     `json:"volume"`
	Root     string     `json:"root"`
	Status   string     `json:"status"`
	Started  time.Time  `json:"started"`
	Finished *time.Time `json:"finished,omitempty"`
	Error    string     `json:"error,omitempty"`
	Phases   PhaseTimes `json:"phases"`
	ScanCounts
}

const scanColumns = `id, volume_id::text, (select label from volumes v where v.id = scans.volume_id), root, status,
	started_at, finished_at, error, walk_ms, hash_ms, archives_ms, text_ms, listed, written, missing,
	skipped, hashed, hashed_bytes, duplicates, archives, members, texts, text_chars, metadata, metadata_ms`

func scanScanInfo(row pgx.Row) (ScanInfo, error) {
	var si ScanInfo
	var walk, hash, archives, text, metadataMS int64
	err := row.Scan(&si.ID, &si.VolumeID, &si.Volume, &si.Root, &si.Status, &si.Started, &si.Finished, &si.Error,
		&walk, &hash, &archives, &text, &si.Listed, &si.Written, &si.Missing, &si.Skipped, &si.Hashed, &si.HashedBytes,
		&si.Duplicates, &si.Archives, &si.Members, &si.Texts, &si.TextChars, &si.Metadata, &metadataMS)
	si.Phases = PhaseTimes{Walk: time.Duration(walk) * time.Millisecond, Hash: time.Duration(hash) * time.Millisecond,
		Archives: time.Duration(archives) * time.Millisecond, Text: time.Duration(text) * time.Millisecond, Metadata: time.Duration(metadataMS) * time.Millisecond}
	return si, err
}

// Scans is the scan history, newest first, of one volume when volumeID is set.
func (s *Store) Scans(ctx context.Context, volumeID string, limit int) ([]ScanInfo, error) {
	rows, err := s.pool.Query(ctx, `select `+scanColumns+` from scans
		where $1 = '' or volume_id::text = $1 order by id desc limit $2`, volumeID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ScanInfo, error) { return scanScanInfo(r) })
}

// LatestScan is the newest scan, of one volume when volumeID is set.
func (s *Store) LatestScan(ctx context.Context, volumeID string) (ScanInfo, error) {
	si, err := scanScanInfo(s.pool.QueryRow(ctx, `select `+scanColumns+` from scans
		where $1 = '' or volume_id::text = $1 order by id desc limit 1`, volumeID))
	if errors.Is(err, pgx.ErrNoRows) {
		return si, fmt.Errorf("no scans yet: %w", ErrNotFound)
	}
	return si, err
}

func (s *Store) ScanByID(ctx context.Context, id int64) (ScanInfo, error) {
	si, err := scanScanInfo(s.pool.QueryRow(ctx, `select `+scanColumns+` from scans where id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return si, fmt.Errorf("scan %d: %w", id, ErrNotFound)
	}
	return si, err
}

// VolumeSummary is one volume with what the catalogue holds for it.
type VolumeSummary struct {
	Volume
	Entries  int64     `json:"entries"`
	Files    int64     `json:"files"`
	Bytes    int64     `json:"bytes"`
	Hashed   int64     `json:"hashed"`
	Pending  int64     `json:"pending"`
	Missing  int64     `json:"missing"`
	LastScan *ScanInfo `json:"last_scan,omitempty"`
}

// KnownVolumes lists every volume the catalogue has seen.
func (s *Store) KnownVolumes(ctx context.Context) ([]Volume, error) {
	rows, err := s.pool.Query(ctx, `select `+volumeColumns+` from volumes order by label, first_seen`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Volume, error) { return scanVolume(r) })
}

func (s *Store) Volumes(ctx context.Context) ([]VolumeSummary, error) {
	vols, err := s.KnownVolumes(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]VolumeSummary, len(vols))
	index := map[string]int{}
	for i, v := range vols {
		out[i].Volume = v
		index[v.ID] = i
	}
	rows, err := s.pool.Query(ctx, `
		select volume_id::text, count(*) filter (where missing_scan is null),
		       count(*) filter (where kind = 'file' and missing_scan is null),
		       coalesce(sum(size_bytes) filter (where kind = 'file' and missing_scan is null), 0),
		       count(*) filter (where hash_state = 'done' and missing_scan is null),
		       count(*) filter (where hash_state in ('pending', 'failed') and missing_scan is null),
		       count(*) filter (where missing_scan is not null)
		from entries group by volume_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var vs VolumeSummary
		if err := rows.Scan(&id, &vs.Entries, &vs.Files, &vs.Bytes, &vs.Hashed, &vs.Pending, &vs.Missing); err != nil {
			return nil, err
		}
		if i, ok := index[id]; ok {
			vs.Volume = out[i].Volume
			out[i] = vs
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		si, err := s.LatestScan(ctx, out[i].ID)
		if err == nil {
			out[i].LastScan = &si
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
	}
	return out, nil
}

// Dupe is one content stored in more than one place.
type Dupe struct {
	Ref    string `json:"ref"`
	Size   int64  `json:"size"`
	Copies int64  `json:"copies"`
	// Wasted is what all copies but one occupy.
	Wasted int64 `json:"wasted"`
	Places []Hit `json:"places"`
}

// Dupes lists contents with more than one present copy, largest waste first.
// sameVolume counts only copies that share a volume: copies on two backup
// disks are usually the point, copies on one disk rarely are.
func (s *Store) Dupes(ctx context.Context, minSize int64, sameVolume bool, limit int) ([]Dupe, int64, error) {
	group, volume := `c.id`, `null::text`
	if sameVolume {
		group, volume = `c.id, e.volume_id`, `e.volume_id::text`
	}
	rows, err := s.pool.Query(ctx, `
		with d as (
			select c.id, `+refSQL+` as ref, c.size_bytes, `+volume+` as volume_id, count(*) as copies
			from entries e join contents c on c.id = e.content_id
			where e.missing_scan is null and c.size_bytes >= $1
			group by `+group+` having count(*) > 1
		)
		select id, ref, size_bytes, sum(copies)::bigint, sum((copies - 1) * size_bytes)::bigint,
		       sum(sum((copies - 1) * size_bytes)) over ()::bigint,
		       array_agg(volume_id) filter (where volume_id is not null)
		from d group by id, ref, size_bytes
		order by 5 desc, id limit $2`, minSize, limit)
	if err != nil {
		return nil, 0, err
	}
	var ids []int64
	var volumes [][]string
	var total int64
	dupes, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Dupe, error) {
		var d Dupe
		var id int64
		var vols []string
		err := r.Scan(&id, &d.Ref, &d.Size, &d.Copies, &d.Wasted, &total, &vols)
		ids = append(ids, id)
		volumes = append(volumes, vols)
		return d, err
	})
	if err != nil {
		return nil, 0, err
	}
	// Places are the copies the count is about: present ones, and with
	// sameVolume only on the volumes holding more than one.
	for i, id := range ids {
		places, err := s.occurrences(ctx, id, 0, true, copies{volumes: volumes[i]})
		if err != nil {
			return nil, 0, err
		}
		dupes[i].Places = places
	}
	return dupes, total, nil
}

// SkipGroup counts one reason and rule in a scan's skips.
type SkipGroup struct {
	Reason  string `json:"reason"`
	Rule    string `json:"rule,omitempty"`
	Count   int64  `json:"count"`
	Example string `json:"example"`
}

type Skip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Rule   string `json:"rule,omitempty"`
	Detail string `json:"detail,omitempty"`
}

func (s *Store) SkipGroups(ctx context.Context, scanID int64) ([]SkipGroup, error) {
	rows, err := s.pool.Query(ctx, `
		select reason, rule, count(*), min(path) from skips where scan_id = $1
		group by reason, rule order by count(*) desc, reason, rule`, scanID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (SkipGroup, error) {
		var g SkipGroup
		err := r.Scan(&g.Reason, &g.Rule, &g.Count, &g.Example)
		return g, err
	})
}

func (s *Store) Skips(ctx context.Context, scanID int64, reason, rule string, limit int) ([]Skip, error) {
	rows, err := s.pool.Query(ctx, `
		select path, reason, rule, detail from skips
		where scan_id = $1 and ($2 = '' or reason = $2) and ($3 = '' or rule = $3)
		order by path collate "C" limit $4`, scanID, reason, rule, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Skip, error) {
		var sk Skip
		err := r.Scan(&sk.Path, &sk.Reason, &sk.Rule, &sk.Detail)
		return sk, err
	})
}

// Totals is the whole catalogue in numbers.
type Totals struct {
	Volumes      int64 `json:"volumes"`
	Entries      int64 `json:"entries"`
	Files        int64 `json:"files"`
	Bytes        int64 `json:"bytes"`
	Contents     int64 `json:"contents"`
	ContentBytes int64 `json:"content_bytes"`
	Pending      int64 `json:"pending"`
	Missing      int64 `json:"missing"`
	Archives     int64 `json:"archives"`
	Members      int64 `json:"members"`
	// Texts counts read documents by status.
	Texts     map[string]int64 `json:"texts"`
	TextChars int64            `json:"text_chars"`
	Metadata  int64            `json:"metadata"`
}

func (s *Store) Totals(ctx context.Context) (Totals, error) {
	var t Totals
	// Entries, files and bytes count what is present; missing entries have
	// their own number. A content, and its listing or text, counts while a
	// present entry still has it.
	err := s.pool.QueryRow(ctx, `
		with live as (select distinct content_id from entries where content_id is not null and missing_scan is null)
		select (select count(*) from volumes),
		       count(*) filter (where missing_scan is null), count(*) filter (where kind = 'file' and missing_scan is null),
		       coalesce(sum(size_bytes) filter (where kind = 'file' and missing_scan is null), 0),
		       (select count(*) from live),
		       (select coalesce(sum(c.size_bytes), 0) from contents c join live l on l.content_id = c.id),
		       count(*) filter (where hash_state in ('pending', 'failed') and missing_scan is null),
		       count(*) filter (where missing_scan is not null),
		       (select count(*) from archives a join live l using (content_id) where a.status <> 'not_archive'),
		       (select coalesce(sum(a.members), 0)::bigint from archives a join live l using (content_id)),
		       (select count(*) from metadata m join live l using (content_id))
		from entries`).Scan(&t.Volumes, &t.Entries, &t.Files, &t.Bytes, &t.Contents, &t.ContentBytes, &t.Pending, &t.Missing,
		&t.Archives, &t.Members, &t.Metadata)
	if err != nil {
		return t, err
	}
	rows, err := s.pool.Query(ctx, `
		select t.status, count(*), coalesce(sum(t.chars), 0)::bigint from texts t
		where exists (select 1 from entries e where e.content_id = t.content_id and e.missing_scan is null)
		group by t.status`)
	if err != nil {
		return t, err
	}
	defer rows.Close()
	t.Texts = map[string]int64{}
	for rows.Next() {
		var status string
		var n, chars int64
		if err := rows.Scan(&status, &n, &chars); err != nil {
			return t, err
		}
		t.Texts[status] = n
		t.TextChars += chars
	}
	return t, rows.Err()
}
