package store

import (
	"context"
	"errors"
	"fmt"
	"path"
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

	store      *Store
	lock       *pgxpool.Conn
	tx         pgx.Tx
	dirty      int
	lastCommit time.Time
	skips      [][]any
}

type ScanCounts struct {
	Listed      int64 `json:"listed"`
	Written     int64 `json:"written"`
	Missing     int64 `json:"missing"`
	Skipped     int64 `json:"skipped"`
	Hashed      int64 `json:"hashed"`
	HashedBytes int64 `json:"hashed_bytes"`
	Duplicates  int64 `json:"duplicates"`
}

const (
	commitEvery = 2 * time.Second
	commitRows  = 5000
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
		where volume_id = $1 and status in ('walking', 'hashing')`, v.ID); err != nil {
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
	// seconds is what interrupting means, not an error to report.
	if status == "interrupted" {
		err = nil
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
		       skipped = $7, hashed = $8, hashed_bytes = $9, duplicates = $10
		where id = $1`,
		sc.ID, status, msg, sc.Counts.Listed, sc.Counts.Written, sc.Counts.Missing, sc.Counts.Skipped,
		sc.Counts.Hashed, sc.Counts.HashedBytes, sc.Counts.Duplicates)
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
		hashed_bytes = $7, duplicates = $8 where id = $1`,
		sc.ID, sc.Counts.Listed, sc.Counts.Written, sc.Counts.Missing, sc.Counts.Skipped,
		sc.Counts.Hashed, sc.Counts.HashedBytes, sc.Counts.Duplicates)
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
	Name        string
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
}

const entryRowColumns = `id, parent_id, kind, name, path, file_id, size_bytes, created_at, modified_at, accessed_at,
	changed_at, attributes, hash_state, missing_scan`

func collectEntryRows(rows pgx.Rows) ([]entryRow, error) {
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (entryRow, error) {
		var e entryRow
		err := r.Scan(&e.ID, &e.ParentID, &e.Kind, &e.Name, &e.Path, &e.FileID, &e.Size, &e.Created, &e.Modified,
			&e.Accessed, &e.Changed, &e.Attributes, &e.HashState, &e.MissingScan)
		return e, err
	})
}

// ApplyListing reconciles one folder's listing with the catalogue and returns
// the subfolders to descend into, in listing order.
//
// A listed entry is matched to an existing row by, in order: its file id among
// the folder's rows; its file id anywhere on the volume, which means it moved
// here; its name among rows nothing else claimed. On NTFS a name match with a
// new file id is a file replaced in place by a save-via-rename, and keeps its
// row. A matched row is only written when something about it changed, so
// rescanning an unchanged disk writes almost nothing.
//
// parent is nil for the volume root. complete says the listing is the whole
// folder: only then are rows it no longer contains marked missing, never
// after a partial read. keep names entries that exist but were excluded,
// which are neither indexed nor marked missing.
func (sc *Scan) ApplyListing(ctx context.Context, parent *Dir, listed []Listed, keep map[string]bool, complete bool) ([]Dir, error) {
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

	seenIDs := map[int64]bool{}
	for i := range listed {
		listed[i] = normalize(listed[i], sc.Volume.StableIDs)
		// Hard links in one folder share a file id. The second keeps its
		// path as identity instead; ids are unique per volume.
		if id := listed[i].FileID; id != 0 {
			if seenIDs[id] {
				listed[i].FileID = 0
			}
			seenIDs[id] = true
		}
	}
	matched := make([]*entryRow, len(listed))
	claimed := map[int64]bool{}
	claim := func(i int, r *entryRow) {
		matched[i] = r
		claimed[r.ID] = true
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
			if r := byID[l.FileID]; l.FileID != 0 && r != nil && !claimed[r.ID] {
				claim(i, r)
			} else if l.FileID != 0 {
				elsewhere = append(elsewhere, l.FileID)
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
				if r := byMovedID[l.FileID]; matched[i] == nil && r != nil && !claimed[r.ID] {
					claim(i, r)
				}
			}
		}
	}
	byName := map[string]*entryRow{}
	for i := range existing {
		byName[existing[i].Name] = &existing[i]
	}
	for i, l := range listed {
		if r := byName[l.Name]; matched[i] == nil && r != nil && !claimed[r.ID] {
			claim(i, r)
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
	var fresh newRows
	for i, l := range listed {
		entryPath := ""
		if parent != nil {
			entryPath = parentPath + "/" + l.Name
		}
		paths[i] = entryPath
		r := matched[i]
		if r == nil {
			fresh.add(l, entryPath)
			continue
		}
		ids[i] = r.ID
		moved := r.Path != entryPath
		if moved && r.Kind == "dir" && l.Kind == "dir" {
			// Everything below a moved folder moves with it in one statement.
			batch.Queue(`
				update entries set path = $3 || substr(path, length($2) + 1)
				where volume_id = $1 and path collate "C" > $2 || '/' and path collate "C" < $2 || '0'`,
				sc.Volume.ID, r.Path, entryPath)
			reads = append(reads, execResult)
		}
		if !moved && unchanged(r, l, parentID) {
			continue
		}
		reset, state := contentAfter(r, l, moved)
		batch.Queue(`
			update entries set parent_id = $2, kind = $3, name = $4, path = $5, ext = $6, file_id = $7, size_bytes = $8,
			       created_at = $9, modified_at = $10, accessed_at = $11, changed_at = $12, attributes = $13,
			       content_id = case when $14 then null else content_id end, hash_state = $15,
			       missing_scan = null, updated_scan = $16
			where id = $1`,
			r.ID, parentID, l.Kind, l.Name, entryPath, ext(l), nullID(l.FileID), l.Size, nullTime(l.Created),
			nullTime(l.Modified), nullTime(l.Accessed), nullTime(l.Changed), l.Attributes, reset, state, sc.ID)
		reads = append(reads, execResult)
		sc.Counts.Written++
		sc.dirty++
	}
	if complete {
		for i := range existing {
			r := &existing[i]
			if claimed[r.ID] || keep[r.Name] || r.MissingScan != nil {
				continue
			}
			batch.Queue(`update entries set missing_scan = $2 where id = $1`, r.ID, sc.ID)
			reads = append(reads, execResult)
			sc.dirty++
		}
		if parent != nil {
			batch.Queue(`update entries set listed_scan = $2 where id = $1`, parent.ID, sc.ID)
			reads = append(reads, execResult)
		}
	}
	inserted := map[string]int64{}
	if len(fresh.name) > 0 {
		// One statement for every new entry of the folder: a first scan is
		// mostly inserts, and the BM25 index takes rows far faster in bulk.
		batch.Queue(`
			insert into entries (volume_id, parent_id, kind, name, path, ext, file_id, size_bytes, created_at,
			                     modified_at, accessed_at, changed_at, attributes, hash_state, first_scan, updated_scan)
			select $1, $2, u.kind, u.name, u.path, u.ext, u.file_id, u.size, u.created, u.modified, u.accessed,
			       u.changed, u.attributes, u.state, $3, $3
			from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::bigint[], $10::timestamptz[],
			            $11::timestamptz[], $12::timestamptz[], $13::timestamptz[], $14::int[], $15::text[])
			     as u(kind, name, path, ext, file_id, size, created, modified, accessed, changed, attributes, state)
			returning id, name`,
			sc.Volume.ID, parentID, sc.ID, fresh.kind, fresh.name, fresh.path, fresh.ext, fresh.fileID, fresh.size,
			fresh.created, fresh.modified, fresh.accessed, fresh.changed, fresh.attributes, fresh.state)
		reads = append(reads, func(br pgx.BatchResults) error {
			rows, err := br.Query()
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id int64
				var name string
				if err := rows.Scan(&id, &name); err != nil {
					return err
				}
				inserted[name] = id
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
			if id = inserted[l.Name]; id == 0 {
				return nil, fmt.Errorf("insert %s returned no id", paths[i])
			}
		}
		dirs = append(dirs, Dir{ID: id, Path: paths[i]})
	}
	return dirs, nil
}

// newRows collects a folder's new entries column by column for one unnest
// insert. Pointers carry NULLs.
type newRows struct {
	kind, name, path, ext, state         []string
	fileID                               []*int64
	size                                 []int64
	created, modified, accessed, changed []*time.Time
	attributes                           []int32
}

func (n *newRows) add(l Listed, entryPath string) {
	n.kind = append(n.kind, l.Kind)
	n.name = append(n.name, l.Name)
	n.path = append(n.path, entryPath)
	n.ext = append(n.ext, ext(l))
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
	l.Name = cleanText(l.Name)
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
	return r.MissingScan == nil && r.Kind == l.Kind && r.Name == l.Name && samePtr(r.ParentID, parentID) &&
		samePtr(r.FileID, nullIDPtr(l.FileID)) && r.Size == l.Size && r.Attributes == l.Attributes &&
		sameTime(r.Created, l.Created) && sameTime(r.Modified, l.Modified) && sameTime(r.Accessed, l.Accessed) &&
		sameTime(r.Changed, l.Changed) && hashStateAfter(r.HashState, l.HashState) == r.HashState
}

// contentAfter decides whether a changed entry keeps its content. Size or
// modified time changing means new bytes. A change time that moved while the
// entry stayed put does too: some writers restore the modified time. A rename
// or move also moves the change time on NTFS, so it does not count there.
func contentAfter(r *entryRow, l Listed, moved bool) (bool, string) {
	if l.Kind != "file" {
		return true, "none"
	}
	if r.Kind != "file" || r.Size != l.Size || !sameTime(r.Modified, l.Modified) || (!moved && !sameTime(r.Changed, l.Changed)) {
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

func ext(l Listed) string {
	if l.Kind != "file" {
		return ""
	}
	return strings.ToLower(strings.TrimPrefix(path.Ext(l.Name), "."))
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

// NextPending returns up to limit files after the given path, in path order,
// which keeps reads on a hard disk roughly sequential.
func (sc *Scan) NextPending(ctx context.Context, after string, limit int) ([]Pending, error) {
	lower, upper := sc.subtree()
	if after > lower {
		lower = after
	}
	rows, err := sc.store.pool.Query(ctx, `
		select id, path, size_bytes from entries
		where volume_id = $1 and hash_state in ('pending', 'failed') and kind = 'file' and missing_scan is null
		  and path collate "C" > $2 and ($3 = '' or path collate "C" < $3)
		order by path collate "C" limit $4`,
		sc.Volume.ID, lower, upper, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Pending, error) {
		var p Pending
		err := r.Scan(&p.ID, &p.Path, &p.Size)
		return p, err
	})
}

// SetContent attaches a digest to a file. The update only applies while the
// row still has the size that was hashed; a rescan in between would have
// queued it again anyway.
func (sc *Scan) SetContent(ctx context.Context, p Pending, digest [32]byte) error {
	tx, err := sc.begin(ctx)
	if err != nil {
		return err
	}
	var inserted bool
	err = tx.QueryRow(ctx, `
		with c as (
			insert into contents (blake3, size_bytes) values ($2, $3)
			on conflict (blake3) do update set size_bytes = excluded.size_bytes
			returning id, xmax = 0 as inserted
		)
		update entries e set content_id = c.id, hash_state = 'done', updated_scan = $4
		from c where e.id = $1 and e.size_bytes = $3
		returning c.inserted`,
		p.ID, digest[:], p.Size, sc.ID).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	sc.Counts.Hashed++
	sc.Counts.HashedBytes += p.Size
	if !inserted {
		sc.Counts.Duplicates++
	}
	sc.dirty++
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
