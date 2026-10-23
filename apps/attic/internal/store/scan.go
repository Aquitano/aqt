package store

import (
	"context"
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Scan is one run over one folder of one volume. It holds an advisory lock for
// its whole life, so two scans of a volume cannot interleave their identity
// decisions. Writes are batched into transactions that commit every couple of
// seconds, which is what lets search see a scan's progress while it runs.
type Scan struct {
	ID     int64
	Volume Volume
	// Root is the scanned folder, volume-relative like Entry.Path.
	Root   string
	Counts ScanCounts
	// Phases is how long each phase took, written when the scan finishes.
	Phases PhaseTimes

	store       *Store
	lock        *pgxpool.Conn
	tx          pgx.Tx
	dirty       int
	lastCommit  time.Time
	skips       [][]any
	hashes      []completedHash
	hashInserts map[int64]bool
	heldFiles   map[fileLocation]bool
}

type fileLocation struct {
	path   string
	fileID int64
}

type ScanCounts struct {
	Listed      int64 `json:"listed"`
	Written     int64 `json:"written"`
	Missing     int64 `json:"missing"`
	Skipped     int64 `json:"skipped"`
	Hashed      int64 `json:"hashed"`
	HashedBytes int64 `json:"hashed_bytes"`
	Duplicates  int64 `json:"duplicates"`
	Archives    int64 `json:"archives"`
	Members     int64 `json:"members"`
	Texts       int64 `json:"texts"`
	TextChars   int64 `json:"text_chars"`
	Metadata    int64 `json:"metadata"`
}

// PhaseTimes is how long each phase of a scan took; zero for one that did not
// run.
type PhaseTimes struct {
	Walk     time.Duration `json:"walk"`
	Hash     time.Duration `json:"hash"`
	Archives time.Duration `json:"archives"`
	Text     time.Duration `json:"text"`
	Metadata time.Duration `json:"metadata"`
}

const (
	commitEvery = 2 * time.Second
	commitRows  = 5000
	hashBatch   = 64
)

// Dir is a folder the scan has recorded and may descend into.
type Dir struct {
	ID   int64
	Path string
}

// Listed is one directory entry in the form the catalogue stores it. Times
// are UTC; zero means unknown. FileID is zero on volumes without stable ids.
type Listed struct {
	Name       string
	Kind       string // dir | file | link
	FileID     int64
	Size       int64
	Created    time.Time
	Modified   time.Time
	Accessed   time.Time
	Changed    time.Time
	Attributes int32
	// HashState is what the scan wants for a file: pending, or skipped when
	// its contents must not be read. Folders and links use none.
	HashState string

	rawName        string
	physicalFileID int64
}

func (s *Store) StartScan(ctx context.Context, v Volume, root string) (*Scan, error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	var locked bool
	if err := conn.QueryRow(ctx, `select pg_try_advisory_lock(hashtextextended($1, 0))`, scanLockKey(v.ID)).Scan(&locked); err != nil {
		conn.Release()
		return nil, err
	}
	if !locked {
		conn.Release()
		return nil, fmt.Errorf("a scan of volume %q is already running", v.Label)
	}
	sc := &Scan{Volume: v, Root: root, store: s, lock: conn, lastCommit: time.Now()}
	// Holding the lock means no other scan of this volume is alive, so any
	// still marked as running was killed before it could say so.
	if _, err := conn.Exec(ctx, `update scans set status = 'interrupted', finished_at = now()
		where volume_id = $1 and status in ('walking', 'hashing', 'listing', 'reading', 'metadata')`, v.ID); err != nil {
		sc.unlock(ctx)
		return nil, err
	}
	if err := conn.QueryRow(ctx, `insert into scans (volume_id, root, status) values ($1, $2, 'walking') returning id`,
		v.ID, root).Scan(&sc.ID); err != nil {
		sc.unlock(ctx)
		return nil, err
	}
	return sc, nil
}

func scanLockKey(volumeID string) string { return "attic-scan:" + volumeID }

func (sc *Scan) unlock(ctx context.Context) {
	_, _ = sc.lock.Exec(context.WithoutCancel(ctx), `select pg_advisory_unlock(hashtextextended($1, 0))`, scanLockKey(sc.Volume.ID))
	sc.lock.Release()
}

// SetStatus records which phase the scan is in.
func (sc *Scan) SetStatus(ctx context.Context, status string) error {
	_, err := sc.lock.Exec(ctx, `update scans set status = $2 where id = $1`, sc.ID, status)
	return err
}

// Finish commits what is pending and closes the scan with its final status.
// It runs even when ctx was cancelled, so an interrupted scan keeps its work.
func (sc *Scan) Finish(ctx context.Context, status string, failure error) error {
	ctx = context.WithoutCancel(ctx)
	defer sc.unlock(ctx)
	err := sc.Commit(ctx)
	if err != nil && sc.tx != nil {
		_ = sc.tx.Rollback(ctx)
	}
	// Ctrl+C can cancel a statement mid-transaction. Losing the last couple of
	// seconds is what interrupting means, not an error to report. Otherwise a
	// lost final batch makes the scan a failure, whatever came before.
	if status == "interrupted" {
		err = nil
	} else if err != nil {
		status = "failed"
		failure = errors.Join(failure, err)
	}
	msg := ""
	if failure != nil {
		msg = failure.Error()
	}
	// Counted here rather than while walking: a file marked missing in its old
	// folder may turn up later in the same scan, moved.
	if cerr := sc.lock.QueryRow(ctx, `select count(*) from entries where missing_scan = $1`, sc.ID).Scan(&sc.Counts.Missing); cerr != nil {
		err = errors.Join(err, cerr)
	}
	_, uerr := sc.lock.Exec(ctx, `
		update scans set status = $2, error = $3, finished_at = now(), listed = $4, written = $5, missing = $6,
		       skipped = $7, hashed = $8, hashed_bytes = $9, duplicates = $10, archives = $11, members = $12,
		       texts = $13, text_chars = $14, walk_ms = $15, hash_ms = $16, archives_ms = $17, text_ms = $18, metadata = $19, metadata_ms = $20
		where id = $1`,
		sc.ID, status, msg, sc.Counts.Listed, sc.Counts.Written, sc.Counts.Missing, sc.Counts.Skipped,
		sc.Counts.Hashed, sc.Counts.HashedBytes, sc.Counts.Duplicates, sc.Counts.Archives, sc.Counts.Members,
		sc.Counts.Texts, sc.Counts.TextChars, sc.Phases.Walk.Milliseconds(), sc.Phases.Hash.Milliseconds(),
		sc.Phases.Archives.Milliseconds(), sc.Phases.Text.Milliseconds(), sc.Counts.Metadata, sc.Phases.Metadata.Milliseconds())
	return errors.Join(err, uerr)
}

func (sc *Scan) begin(ctx context.Context) (pgx.Tx, error) {
	if sc.tx == nil {
		tx, err := sc.store.pool.Begin(ctx)
		if err != nil {
			return nil, err
		}
		sc.tx = tx
	}
	return sc.tx, nil
}

// MaybeCommit commits once enough time or rows have accumulated.
func (sc *Scan) MaybeCommit(ctx context.Context) error {
	if sc.dirty >= commitRows || time.Since(sc.lastCommit) >= commitEvery {
		return sc.Commit(ctx)
	}
	return nil
}

// Commit makes everything so far visible, to search and to the hashing queue.
func (sc *Scan) Commit(ctx context.Context) error {
	if err := sc.flushContents(ctx); err != nil {
		return err
	}
	if len(sc.skips) > 0 {
		tx, err := sc.begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"skips"}, []string{"scan_id", "path", "reason", "rule", "detail"},
			pgx.CopyFromRows(sc.skips)); err != nil {
			return err
		}
		sc.skips = sc.skips[:0]
	}
	if sc.tx != nil {
		if err := sc.tx.Commit(ctx); err != nil {
			return err
		}
		sc.tx = nil
	}
	sc.dirty = 0
	sc.lastCommit = time.Now()
	_, err := sc.lock.Exec(ctx, `update scans set listed = $2, written = $3, missing = $4, skipped = $5, hashed = $6,
		hashed_bytes = $7, duplicates = $8, archives = $9, members = $10,
		texts = $11, text_chars = $12, metadata = $13 where id = $1`,
		sc.ID, sc.Counts.Listed, sc.Counts.Written, sc.Counts.Missing, sc.Counts.Skipped,
		sc.Counts.Hashed, sc.Counts.HashedBytes, sc.Counts.Duplicates, sc.Counts.Archives, sc.Counts.Members,
		sc.Counts.Texts, sc.Counts.TextChars, sc.Counts.Metadata)
	return err
}

// Skip records something the scan left out, with the reason and the rule.
func (sc *Scan) Skip(entryPath, reason, rule, detail string) {
	sc.skips = append(sc.skips, []any{sc.ID, cleanText(entryPath), reason, rule, cleanText(detail)})
	sc.Counts.Skipped++
	sc.dirty++
}

// entryRow is what ApplyListing compares a listed entry against.
type entryRow struct {
	ID          int64
	ParentID    *int64
	Kind        string
	Path        string
	FileID      *int64
	Size        int64
	Created     *time.Time
	Modified    *time.Time
	Accessed    *time.Time
	Changed     *time.Time
	Attributes  int32
	HashState   string
	MissingScan *int64

	RawName        []byte
	PhysicalFileID *int64
}

const entryRowColumns = `id, parent_id, kind, path, file_id, size_bytes, created_at, modified_at, accessed_at,
	changed_at, attributes, hash_state, missing_scan, raw_name, physical_file_id`

func collectEntryRows(rows pgx.Rows) ([]entryRow, error) {
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (entryRow, error) {
		var e entryRow
		err := r.Scan(&e.ID, &e.ParentID, &e.Kind, &e.Path, &e.FileID, &e.Size, &e.Created, &e.Modified,
			&e.Accessed, &e.Changed, &e.Attributes, &e.HashState, &e.MissingScan, &e.RawName, &e.PhysicalFileID)
		return e, err
	})
}

// ApplyListing reconciles one folder's listing with the catalogue and returns
// the subfolders to descend into, in listing order.
//
// A listed entry is matched to an existing row by, in order: its file id among
// the folder's rows; its file id elsewhere on the volume, unless that row's
// path still holds the file, which makes the entry another hard link; its name
// among rows nothing else claimed. On NTFS a name match with a new file id is
// a file replaced in place by a save-via-rename, and keeps its row. A matched
// row is only written when something about it changed, so rescanning an
// unchanged disk writes almost nothing.
//
// parent is nil for the volume root. complete says the listing is the whole
// folder: only then are rows it no longer contains marked missing, never
// after a partial read. keep names entries that exist but were excluded,
// which are neither indexed nor marked missing. holds reports whether a
// catalogued path still holds a file id, and says yes when it cannot tell: a
// wrong yes costs a hash, a wrong no moves a row away from a path that exists.
func (sc *Scan) ApplyListing(ctx context.Context, parent *Dir, listed []Listed, keep map[string]bool, complete bool,
	holds func(entryPath string, fileID int64) bool) ([]Dir, error) {
	tx, err := sc.begin(ctx)
	if err != nil {
		return nil, err
	}
	var rows pgx.Rows
	if parent == nil {
		rows, err = tx.Query(ctx, `select `+entryRowColumns+` from entries where volume_id = $1 and parent_id is null`, sc.Volume.ID)
	} else {
		rows, err = tx.Query(ctx, `select `+entryRowColumns+` from entries where parent_id = $1`, parent.ID)
	}
	if err != nil {
		return nil, err
	}
	existing, err := collectEntryRows(rows)
	if err != nil {
		return nil, err
	}

	listedNames := make(map[string]int, len(listed))
	for i := range listed {
		listed[i] = normalize(listed[i], sc.Volume.StableIDs)
		listedNames[listed[i].rawName] = i
	}
	owners := map[int64]int{}
	for _, r := range existing {
		if r.FileID == nil {
			continue
		}
		if i, ok := listedNames[string(r.RawName)]; ok && listed[i].FileID == *r.FileID {
			owners[*r.FileID] = i
		}
	}
	for i := range listed {
		if id := listed[i].FileID; id != 0 {
			if owner, ok := owners[id]; ok && owner != i {
				listed[i].FileID = 0
			} else {
				owners[id] = i
			}
		}
	}
	matched := make([]*entryRow, len(listed))
	claimed := map[int64]bool{}
	var vacated []int64
	claim := func(i int, r *entryRow) {
		matched[i] = r
		claimed[r.ID] = true
	}
	// A folder can hold several rows of one name: a missing one beside the
	// live one, or a hard link kept by path.
	byName := map[string][]*entryRow{}
	for i := range existing {
		byName[string(existing[i].RawName)] = append(byName[string(existing[i].RawName)], &existing[i])
	}
	// A path the catalogue keeps as a hard link stays one when its file id
	// turns up on another row: that row's path holds the id or is gone. A row
	// whose path is gone is vacated, marked missing now rather than whenever
	// its own folder is next scanned.
	keptAsLink := func(l Listed) bool {
		return l.Kind == "file" && slices.ContainsFunc(byName[l.rawName], func(r *entryRow) bool { return r.FileID == nil })
	}

	if sc.Volume.StableIDs {
		byID := map[int64]*entryRow{}
		for i := range existing {
			if existing[i].FileID != nil {
				byID[*existing[i].FileID] = &existing[i]
			}
		}
		var elsewhere []int64
		for i, l := range listed {
			r := byID[l.FileID]
			switch {
			case l.FileID == 0:
			case r == nil || claimed[r.ID]:
				elsewhere = append(elsewhere, l.FileID)
			case string(r.RawName) != l.rawName && keptAsLink(l):
				listed[i].FileID = 0
			default:
				claim(i, r)
			}
		}
		if len(elsewhere) > 0 {
			rows, err := tx.Query(ctx, `select `+entryRowColumns+` from entries where volume_id = $1 and file_id = any($2)`,
				sc.Volume.ID, elsewhere)
			if err != nil {
				return nil, err
			}
			moved, err := collectEntryRows(rows)
			if err != nil {
				return nil, err
			}
			byMovedID := map[int64]*entryRow{}
			for i := range moved {
				byMovedID[*moved[i].FileID] = &moved[i]
			}
			for i, l := range listed {
				r := byMovedID[l.FileID]
				if matched[i] != nil || r == nil || claimed[r.ID] {
					continue
				}
				if l.Kind == "file" && keptAsLink(l) {
					listed[i].FileID = 0
					if r.MissingScan == nil && !sc.holdsFile(r.Path, l.FileID, holds) {
						vacated = append(vacated, r.ID)
					}
					continue
				}
				if l.Kind == "file" && r.MissingScan == nil && sc.holdsFile(r.Path, l.FileID, holds) {
					listed[i].FileID = 0
					continue
				}
				claim(i, r)
			}
		}
	}
	// Prefer the row without a file id, so a listed entry that also has none
	// never collides with it in the (parent, raw_name) index.
	for i, l := range listed {
		if matched[i] != nil {
			continue
		}
		var best *entryRow
		for _, r := range byName[l.rawName] {
			if !claimed[r.ID] && (best == nil || (r.FileID == nil && best.FileID != nil)) {
				best = r
			}
		}
		if best != nil {
			claim(i, best)
		}
	}

	parentPath, parentID := "", (*int64)(nil)
	if parent != nil {
		parentPath, parentID = parent.Path, &parent.ID
	}
	var batch pgx.Batch
	// One callback per queued statement, in queue order.
	var reads []func(pgx.BatchResults) error
	paths := make([]string, len(listed))
	ids := make([]int64, len(listed))
	var movedIDs, physicalIDs []int64
	for i, l := range listed {
		if parent != nil {
			paths[i] = parentPath + "/" + l.Name
		}
		if r := matched[i]; r != nil && r.Path != paths[i] && l.Kind == "file" &&
			l.physicalFileID != 0 && !sameTime(r.Changed, l.Changed) {
			movedIDs = append(movedIDs, r.ID)
			physicalIDs = append(physicalIDs, l.physicalFileID)
		}
	}
	linked := map[int64]bool{}
	if len(movedIDs) > 0 {
		rows, err := tx.Query(ctx, `
			select moved.id from unnest($2::bigint[], $3::bigint[]) as moved(id, physical_file_id)
			where exists(select 1 from entries link
			             where link.volume_id = $1 and link.physical_file_id = moved.physical_file_id
			               and link.id <> moved.id and link.kind = 'file' and link.missing_scan is null)`,
			sc.Volume.ID, movedIDs, physicalIDs)
		if err != nil {
			return nil, err
		}
		linkedIDs, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return nil, err
		}
		for _, id := range linkedIDs {
			linked[id] = true
		}
	}
	var fresh newRows
	for i, l := range listed {
		entryPath := paths[i]
		r := matched[i]
		if r == nil {
			fresh.add(l, entryPath)
			continue
		}
		ids[i] = r.ID
		moved := r.Path != entryPath
		if moved && r.Kind == "dir" && l.Kind == "dir" {
			// Everything below a moved folder moves with it in one statement.
			// Descendants are found by ancestry, not by path: after a rotation
			// or a swap another folder may already hold the old path.
			batch.Queue(`
				with recursive below as (
					select id from entries where parent_id = $1
					union all
					select e.id from entries e join below b on e.parent_id = b.id
				)
				update entries set path = $3 || substr(path, length($2) + 1)
				where id in (select id from below) and starts_with(path, $2 || '/')`,
				r.ID, r.Path, entryPath)
			reads = append(reads, execResult)
		}
		if r.Kind == "dir" && l.Kind != "dir" {
			batch.Queue(`
				with recursive below as (
					select id from entries where parent_id = $1
					union all
					select e.id from entries e join below b on e.parent_id = b.id
				)
				update entries set missing_scan = $2
				where id in (select id from below) and missing_scan is null`, r.ID, sc.ID)
			reads = append(reads, execResult)
		}
		if !moved && unchanged(r, l, parentID) {
			continue
		}
		reset, state := contentAfter(r, l, moved, linked[r.ID], sc.Volume.FS)
		batch.Queue(`
			update entries set parent_id = $2, kind = $3, name = $4, path = $5, ext = $6, file_id = $7, size_bytes = $8,
			       created_at = $9, modified_at = $10, accessed_at = $11, changed_at = $12, attributes = $13,
			       content_id = case when $14 then null else content_id end, hash_state = $15,
			       missing_scan = null, updated_scan = $16, raw_name = $17, physical_file_id = $18
			where id = $1`,
			r.ID, parentID, l.Kind, l.Name, entryPath, ext(l.Kind, l.Name), nullID(l.FileID), l.Size, nullTime(l.Created),
			nullTime(l.Modified), nullTime(l.Accessed), nullTime(l.Changed), l.Attributes, reset, state, sc.ID, []byte(l.rawName), nullIDPtr(l.physicalFileID))
		reads = append(reads, execResult)
		sc.Counts.Written++
		sc.dirty++
	}
	if complete {
		var gone []int64
		for i := range existing {
			r := &existing[i]
			if !claimed[r.ID] && !keep[string(r.RawName)] && r.MissingScan == nil {
				gone = append(gone, r.ID)
			}
		}
		if len(gone) > 0 {
			// A missing folder takes everything below it along: its files must
			// not keep counting as present copies.
			batch.Queue(`
				with recursive below as (
					select id from entries where id = any($1)
					union all
					select e.id from entries e join below b on e.parent_id = b.id
				)
				update entries set missing_scan = $2 where id in (select id from below) and missing_scan is null`,
				gone, sc.ID)
			reads = append(reads, execResult)
			sc.dirty += len(gone)
		}
		if parent != nil {
			batch.Queue(`update entries set listed_scan = $2 where id = $1`, parent.ID, sc.ID)
			reads = append(reads, execResult)
		}
	}
	if len(vacated) > 0 {
		batch.Queue(`update entries set missing_scan = $2 where id = any($1) and missing_scan is null`, vacated, sc.ID)
		reads = append(reads, execResult)
		sc.dirty += len(vacated)
	}
	inserted := map[string]int64{}
	if len(fresh.name) > 0 {
		// One statement for every new entry of the folder: a first scan is
		// mostly inserts, and the BM25 index takes rows far faster in bulk.
		batch.Queue(`
			insert into entries (volume_id, parent_id, kind, name, path, ext, file_id, size_bytes, created_at,
			                     modified_at, accessed_at, changed_at, attributes, hash_state, first_scan, updated_scan, raw_name, physical_file_id)
			select $1, $2, u.kind, u.name, u.path, u.ext, u.file_id, u.size, u.created, u.modified, u.accessed,
			       u.changed, u.attributes, u.state, $3, $3, u.raw_name, u.physical_file_id
			from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::bigint[], $10::timestamptz[],
			            $11::timestamptz[], $12::timestamptz[], $13::timestamptz[], $14::int[], $15::text[], $16::bytea[], $17::bigint[])
			     as u(kind, name, path, ext, file_id, size, created, modified, accessed, changed, attributes, state, raw_name, physical_file_id)
			returning id, raw_name`,
			sc.Volume.ID, parentID, sc.ID, fresh.kind, fresh.name, fresh.path, fresh.ext, fresh.fileID, fresh.size,
			fresh.created, fresh.modified, fresh.accessed, fresh.changed, fresh.attributes, fresh.state, fresh.rawName, fresh.physicalFileID)
		reads = append(reads, func(br pgx.BatchResults) error {
			rows, err := br.Query()
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id int64
				var name []byte
				if err := rows.Scan(&id, &name); err != nil {
					return err
				}
				inserted[string(name)] = id
			}
			return rows.Err()
		})
		sc.Counts.Written += int64(len(fresh.name))
		sc.dirty += len(fresh.name)
	}
	sc.Counts.Listed += int64(len(listed))
	if batch.Len() > 0 {
		br := tx.SendBatch(ctx, &batch)
		for _, read := range reads {
			if err := read(br); err != nil {
				br.Close()
				return nil, err
			}
		}
		if err := br.Close(); err != nil {
			return nil, err
		}
	}
	var dirs []Dir
	for i, l := range listed {
		if l.Kind != "dir" {
			continue
		}
		id := ids[i]
		if id == 0 {
			if id = inserted[l.rawName]; id == 0 {
				return nil, fmt.Errorf("insert %s returned no id", paths[i])
			}
		}
		dirs = append(dirs, Dir{ID: id, Path: paths[i]})
	}
	return dirs, nil
}

func (sc *Scan) holdsFile(entryPath string, fileID int64, observe func(string, int64) bool) bool {
	location := fileLocation{path: entryPath, fileID: fileID}
	if held, ok := sc.heldFiles[location]; ok {
		return held
	}
	if sc.heldFiles == nil {
		sc.heldFiles = make(map[fileLocation]bool)
	}
	held := observe(entryPath, fileID)
	sc.heldFiles[location] = held
	return held
}

// newRows collects a folder's new entries column by column for one unnest
// insert. Pointers carry NULLs.
type newRows struct {
	rawName                              [][]byte
	physicalFileID                       []*int64
	kind, name, path, ext, state         []string
	fileID                               []*int64
	size                                 []int64
	created, modified, accessed, changed []*time.Time
	attributes                           []int32
}

func (n *newRows) add(l Listed, entryPath string) {
	n.kind = append(n.kind, l.Kind)
	n.name = append(n.name, l.Name)
	n.rawName = append(n.rawName, []byte(l.rawName))
	n.physicalFileID = append(n.physicalFileID, nullIDPtr(l.physicalFileID))
	n.path = append(n.path, entryPath)
	n.ext = append(n.ext, ext(l.Kind, l.Name))
	n.state = append(n.state, l.HashState)
	n.fileID = append(n.fileID, nullIDPtr(l.FileID))
	n.size = append(n.size, l.Size)
	n.created = append(n.created, timePtr(l.Created))
	n.modified = append(n.modified, timePtr(l.Modified))
	n.accessed = append(n.accessed, timePtr(l.Accessed))
	n.changed = append(n.changed, timePtr(l.Changed))
	n.attributes = append(n.attributes, l.Attributes)
}

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func execResult(br pgx.BatchResults) error {
	_, err := br.Exec()
	return err
}

// normalize brings a listed entry to what the columns hold, so comparing it
// with a stored row compares like with like: Postgres keeps microseconds,
// Windows reports 100-nanosecond ticks.
func normalize(l Listed, stableIDs bool) Listed {
	l.rawName = l.Name
	l.Name = cleanText(l.Name)
	if stableIDs {
		l.physicalFileID = l.FileID
	}
	for _, t := range []*time.Time{&l.Created, &l.Modified, &l.Accessed, &l.Changed} {
		if !t.IsZero() {
			*t = t.UTC().Truncate(time.Microsecond)
		}
	}
	if !stableIDs {
		l.FileID = 0
	}
	if l.Kind != "file" {
		l.HashState = "none"
	}
	return l
}

func unchanged(r *entryRow, l Listed, parentID *int64) bool {
	return r.MissingScan == nil && r.Kind == l.Kind && string(r.RawName) == l.rawName && samePtr(r.ParentID, parentID) &&
		samePtr(r.FileID, nullIDPtr(l.FileID)) && samePtr(r.PhysicalFileID, nullIDPtr(l.physicalFileID)) && r.Size == l.Size && r.Attributes == l.Attributes &&
		sameTime(r.Created, l.Created) && sameTime(r.Modified, l.Modified) && sameTime(r.Accessed, l.Accessed) &&
		sameTime(r.Changed, l.Changed) && hashStateAfter(r.HashState, l.HashState) == r.HashState
}

// contentAfter keeps content only while its identity, size and write times
// agree. NTFS changes the change time on a move, so single-file moves ignore
// it. Hard links need verification because another path may know newer bytes.
func contentAfter(r *entryRow, l Listed, moved, linked bool, fs string) (bool, string) {
	if l.Kind != "file" {
		return true, "none"
	}
	sameModified := sameTime(r.Modified, l.Modified)
	sameChanged := moved && !linked || sameTime(r.Changed, l.Changed)
	if fs == "FAT" || fs == "FAT32" {
		// FAT has no change time, and Windows shifts its local timestamps at DST.
		sameChanged = true
		sameModified = sameModified || r.Modified != nil && !l.Modified.IsZero() && l.Modified.Sub(*r.Modified).Abs() == time.Hour
	}
	if r.Kind != "file" || !samePtr(r.PhysicalFileID, nullIDPtr(l.physicalFileID)) || r.Size != l.Size || !sameModified || !sameChanged {
		return true, l.HashState
	}
	return false, hashStateAfter(r.HashState, l.HashState)
}

// hashStateAfter keeps a known digest, and lets a change in configuration
// move a file between skipped and queued.
func hashStateAfter(stored, wanted string) string {
	switch {
	case stored == "done", stored == wanted:
		return stored
	case stored == "skipped" && wanted == "pending":
		return "pending"
	case wanted == "skipped":
		return "skipped"
	}
	return stored
}

func ext(kind, name string) string {
	if kind != "file" {
		return ""
	}
	return strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
}

func nullID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

func nullIDPtr(id int64) *int64 {
	if id == 0 {
		return nil
	}
	return &id
}

func samePtr(a, b *int64) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

func sameTime(p *time.Time, t time.Time) bool {
	if t.IsZero() {
		return p == nil
	}
	return p != nil && p.Equal(t)
}

// SetGitRemote records that a folder is a git repository root and where its
// origin points. Zoekt will start from this list.
func (sc *Scan) SetGitRemote(ctx context.Context, dir Dir, remote string) error {
	tx, err := sc.begin(ctx)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `update entries set git_remote = $2 where id = $1 and git_remote is distinct from $2`, dir.ID, cleanText(remote))
	return err
}

// Pending is a file whose content is not known yet.
type Pending struct {
	ID   int64
	Path string
	Size int64

	PhysicalFileID *int64
	Linked         bool
}

type completedHash struct {
	file   Pending
	digest [32]byte
}

// subtree bounds paths at or below the scan root as a byte-order range.
func (sc *Scan) subtree() (lower, upper string) {
	if sc.Root == "" {
		return "", ""
	}
	return sc.Root + "/", sc.Root + "0"
}

// PendingTotals is the hashing work left below the scan root.
func (sc *Scan) PendingTotals(ctx context.Context) (files, bytes int64, err error) {
	lower, upper := sc.subtree()
	err = sc.store.pool.QueryRow(ctx, `
		select count(*), coalesce(sum(size_bytes), 0) from entries
		where volume_id = $1 and hash_state in ('pending', 'failed') and kind = 'file' and missing_scan is null
		  and path collate "C" > $2 and ($3 = '' or path collate "C" < $3)`,
		sc.Volume.ID, lower, upper).Scan(&files, &bytes)
	return files, bytes, err
}

// NextPending returns up to limit files after the given one, in path order,
// which keeps reads on a hard disk roughly sequential. The id breaks ties: two
// rows can briefly share a path, and a path-only keyset would skip one.
func (sc *Scan) NextPending(ctx context.Context, after Pending, limit int) ([]Pending, error) {
	lower, upper := sc.subtree()
	if after.ID != 0 {
		lower = after.Path
	}
	rows, err := sc.store.pool.Query(ctx, `
		select id, path, size_bytes, physical_file_id,
		       exists(select 1 from entries link where link.volume_id = entries.volume_id
		              and link.physical_file_id = entries.physical_file_id and link.id <> entries.id
		              and link.kind = 'file' and link.missing_scan is null)
		from entries
		where volume_id = $1 and hash_state in ('pending', 'failed') and kind = 'file' and missing_scan is null
		  and (path collate "C", id) > ($2, $5) and ($3 = '' or path collate "C" < $3)
		order by path collate "C", id limit $4`,
		sc.Volume.ID, lower, upper, limit, after.ID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Pending, error) {
		var p Pending
		err := r.Scan(&p.ID, &p.Path, &p.Size, &p.PhysicalFileID, &p.Linked)
		return p, err
	})
}

// SetContent queues a digest for a file. Batches flush at 64 files and before
// Commit; each entry update still requires the size that was hashed.
//
// Contents commit independently, so their locks never span later hashing.
// Sorting digests keeps overlapping scans from taking those locks in opposite
// orders. A separate lookup sees contents another scan committed meanwhile.
func (sc *Scan) SetContent(ctx context.Context, p Pending, digest [32]byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sc.hashes = append(sc.hashes, completedHash{file: p, digest: digest})
	if len(sc.hashes) >= hashBatch {
		return sc.flushContents(ctx)
	}
	return nil
}

func (sc *Scan) flushContents(ctx context.Context) error {
	if len(sc.hashes) == 0 {
		return nil
	}
	contentIDs := make(map[[32]byte]int64, len(sc.hashes))
	var digests [][]byte
	var contentSizes []int64
	for i, h := range sc.hashes {
		if _, seen := contentIDs[h.digest]; seen {
			continue
		}
		contentIDs[h.digest] = 0
		digests = append(digests, sc.hashes[i].digest[:])
		contentSizes = append(contentSizes, h.file.Size)
	}
	rows, err := sc.store.pool.Query(ctx, `
		insert into contents (blake3, size_bytes)
		select u.digest, u.size from unnest($1::bytea[], $2::bigint[]) as u(digest, size)
		order by u.digest on conflict (blake3) do nothing returning id`, digests, contentSizes)
	if err != nil {
		return err
	}
	insertedIDs, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	// Kept on the scan: Finish retries a failed flush after these inserts
	// committed, and they must not count as duplicates then.
	if sc.hashInserts == nil {
		sc.hashInserts = make(map[int64]bool, len(insertedIDs))
	}
	for _, id := range insertedIDs {
		sc.hashInserts[id] = true
	}
	rows, err = sc.store.pool.Query(ctx, `select id, blake3 from contents where blake3 = any($1::bytea[])`, digests)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var digest []byte
		if err := rows.Scan(&id, &digest); err != nil {
			return err
		}
		contentIDs[[32]byte(digest)] = id
	}
	if err := rows.Err(); err != nil {
		return err
	}
	ids := make([]int64, len(sc.hashes))
	contents := make([]int64, len(sc.hashes))
	sizes := make([]int64, len(sc.hashes))
	for i, h := range sc.hashes {
		id := contentIDs[h.digest]
		if id == 0 {
			return fmt.Errorf("resolve content %x: %w", h.digest[:8], pgx.ErrNoRows)
		}
		ids[i], contents[i], sizes[i] = h.file.ID, id, h.file.Size
	}
	tx, err := sc.begin(ctx)
	if err != nil {
		return err
	}
	rows, err = tx.Query(ctx, `
		update entries e set content_id = u.content_id, hash_state = 'done', updated_scan = $4
		from unnest($1::bigint[], $2::bigint[], $3::bigint[]) as u(id, content_id, size)
		where e.id = u.id and e.size_bytes = u.size returning e.id`, ids, contents, sizes, sc.ID)
	if err != nil {
		return err
	}
	updatedIDs, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	updated := make(map[int64]bool, len(updatedIDs))
	for _, id := range updatedIDs {
		updated[id] = true
	}
	for _, h := range sc.hashes {
		contentID := contentIDs[h.digest]
		first := sc.hashInserts[contentID]
		delete(sc.hashInserts, contentID)
		// The first occurrence owns the insert even when its size guard fails.
		if !updated[h.file.ID] {
			continue
		}
		sc.Counts.Hashed++
		sc.Counts.HashedBytes += h.file.Size
		if !first {
			sc.Counts.Duplicates++
		}
		sc.dirty++
	}
	sc.hashes = sc.hashes[:0]
	return nil
}

// HashFailed marks a file whose bytes could not be read; the next scan tries
// it again.
func (sc *Scan) HashFailed(ctx context.Context, p Pending, failure error) error {
	tx, err := sc.begin(ctx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update entries set hash_state = 'failed' where id = $1`, p.ID); err != nil {
		return err
	}
	sc.Skip(p.Path, "unreadable", "", failure.Error())
	return nil
}

// SkipHash takes a queued file out of the hashing queue because the rules in
// force now say its bytes must not be read: an exclusion or a size cap added
// after the scan that listed it.
func (sc *Scan) SkipHash(ctx context.Context, p Pending, reason, rule, detail string) error {
	tx, err := sc.begin(ctx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update entries set hash_state = 'skipped' where id = $1`, p.ID); err != nil {
		return err
	}
	sc.Skip(p.Path, reason, rule, detail)
	return nil
}
