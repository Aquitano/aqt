package store_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

func archiveCacheScan(t *testing.T) (*store.Scan, *pgx.Conn, int64) {
	t.Helper()
	st, dsn := storetest.New(t)
	ctx := t.Context()
	v, err := st.ResolveVolume(ctx, disk.Volume{Fingerprint: disk.Fingerprint{FS: "TEST", Serial: "archives"}}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	sc, err := st.StartScan(ctx, v, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sc.Finish(context.Background(), "complete", nil) })
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	var contentID int64
	if err := conn.QueryRow(ctx, `insert into contents (blake3, size_bytes)
		values (decode(repeat('01',32),'hex'), 10) returning id`).Scan(&contentID); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `with root as (
		insert into entries (volume_id, kind, name, raw_name, path, hash_state, first_scan, updated_scan)
		values ($1, 'dir', '', ''::bytea, '', 'none', $3, $3) returning id
	), folders as (
		insert into entries (volume_id, parent_id, kind, name, raw_name, path, hash_state, first_scan, updated_scan)
		select $1, root.id, 'dir', name, convert_to(name, 'UTF8'), '/' || name, 'none', $3, $3
		from root cross join unnest(array['deep', 'shallow']) as name returning id, path
	)
	insert into entries
		(volume_id, parent_id, kind, name, raw_name, path, ext, size_bytes, content_id, hash_state, first_scan, updated_scan)
		select $1, id, 'file', 'copy.zip', 'copy.zip'::bytea, path || '/copy.zip', 'zip', 10, $2, 'done', $3, $3
		from folders`, v.ID, contentID, sc.ID); err != nil {
		t.Fatal(err)
	}
	return sc, conn, contentID
}

func finishArchiveListing(t *testing.T, sc *store.Scan, contentID int64, depth int, paths ...string) {
	t.Helper()
	l, err := sc.StartListing(t.Context(), contentID, depth)
	if err != nil || l == nil {
		t.Fatalf("start listing at depth %d: %v, %v", depth, l, err)
	}
	defer l.Abort(t.Context())
	for _, path := range paths {
		if err := l.Add(t.Context(), archive.Member{Kind: "file", Name: path, Path: path}); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.Finish(t.Context(), archive.Result{Format: "zip", Status: archive.Listed}); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveCacheUpgradesToRequestedDepth(t *testing.T) {
	sc, conn, id := archiveCacheScan(t)
	ctx := t.Context()
	if n, err := sc.ArchiveTotals(ctx, []config.ArchiveScope{{Path: "/", Depth: 1}}); err != nil || n != 1 {
		t.Fatalf("uncached totals: %d, %v", n, err)
	}
	finishArchiveListing(t, sc, id, 1, "nested.zip")
	if _, err := conn.Exec(ctx, `update archives set listed_at = '2000-01-01' where content_id = $1`, id); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ depth, want int }{{1, 0}, {2, 1}} {
		if n, err := sc.ArchiveTotals(ctx, []config.ArchiveScope{{Path: "/", Depth: tc.depth}}); err != nil || n != int64(tc.want) {
			t.Fatalf("depth %d totals: %d, %v", tc.depth, n, err)
		}
		pending, err := sc.NextArchives(ctx, store.PendingArchive{}, 1, []config.ArchiveScope{{Path: "/", Depth: tc.depth}})
		if err != nil || len(pending) != tc.want {
			t.Fatalf("depth %d pending: %+v, %v", tc.depth, pending, err)
		}
		if tc.want != 0 {
			if pending[0].Depth != 1 {
				t.Fatalf("cached depth: %d, want 1", pending[0].Depth)
			}
			next, err := sc.NextArchives(ctx, pending[0], 1, []config.ArchiveScope{{Path: "/", Depth: tc.depth}})
			if err != nil || len(next) != 1 || next[0].ContentID != id || next[0].Path != "/shallow/copy.zip" {
				t.Fatalf("next copy: %+v, %v", next, err)
			}
		}
	}
	finishArchiveListing(t, sc, id, 2, "nested.zip", "nested.zip :: deep.txt")
	var valid bool
	if err := conn.QueryRow(ctx, `select depth = 2 and status = 'listed' and members = 2 and listed_at > '2000-01-01'
		and (select count(*) from members where archive_id = $1) = 2
		and exists (select 1 from members where archive_id = $1 and path = 'nested.zip :: deep.txt')
		from archives where content_id = $1`, id).Scan(&valid); err != nil || !valid {
		t.Fatalf("upgraded cache: valid=%v, %v", valid, err)
	}
	if n, err := sc.ArchiveTotals(ctx, []config.ArchiveScope{{Path: "/", Depth: 2}}); err != nil || n != 0 {
		t.Fatalf("upgraded totals: %d, %v", n, err)
	}
	if sc.Counts.Archives != 2 || sc.Counts.Members != 3 {
		t.Fatalf("upgrade counts: %+v", sc.Counts)
	}
}

func TestArchiveCacheReusesSameOrShallowerDepth(t *testing.T) {
	sc, conn, id := archiveCacheScan(t)
	ctx := t.Context()
	finishArchiveListing(t, sc, id, 2, "nested.zip :: deep.txt")
	var listed time.Time
	if err := conn.QueryRow(ctx, `select listed_at from archives where content_id = $1`, id).Scan(&listed); err != nil {
		t.Fatal(err)
	}
	for _, depth := range []int{2, 1, 0} {
		l, err := sc.StartListing(ctx, id, depth)
		if l != nil {
			l.Abort(ctx)
		}
		if err != nil || l != nil {
			t.Fatalf("depth %d reused cache: %v, %v", depth, l, err)
		}
		if pending, err := sc.NextArchives(ctx, store.PendingArchive{}, 10, []config.ArchiveScope{{Path: "/", Depth: depth}}); err != nil || len(pending) != 0 {
			t.Fatalf("depth %d pending: %+v, %v", depth, pending, err)
		}
	}
	var valid bool
	if err := conn.QueryRow(ctx, `select depth = 2 and members = 1 and listed_at = $2
		and (select count(*) from members where archive_id = $1) = 1
		from archives where content_id = $1`, id, listed).Scan(&valid); err != nil || !valid {
		t.Fatalf("reused cache: valid=%v, %v", valid, err)
	}
	if sc.Counts.Archives != 1 || sc.Counts.Members != 1 {
		t.Fatalf("reuse counts: %+v", sc.Counts)
	}
}

func TestArchiveCacheRollbackPreservesCommittedListing(t *testing.T) {
	sc, conn, id := archiveCacheScan(t)
	ctx := t.Context()
	finishArchiveListing(t, sc, id, 1, "original.txt")
	var listed time.Time
	if err := conn.QueryRow(ctx, `select listed_at from archives where content_id = $1`, id).Scan(&listed); err != nil {
		t.Fatal(err)
	}
	for _, failure := range []string{"abort", "finish cancelled"} {
		t.Run(failure, func(t *testing.T) {
			l, err := sc.StartListing(ctx, id, 2)
			if err != nil || l == nil {
				t.Fatalf("upgrade: %v, %v", l, err)
			}
			defer l.Abort(ctx)
			if err := l.Add(ctx, archive.Member{Kind: "file", Name: "replacement.txt", Path: "replacement.txt"}); err != nil {
				t.Fatal(err)
			}
			if failure == "finish cancelled" {
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				if err := l.Finish(cancelled, archive.Result{Format: "zip", Status: archive.Listed}); err == nil {
					t.Fatal("cancelled finish succeeded")
				}
			}
			l.Abort(ctx)
			l.Abort(ctx)
			var valid bool
			if err := conn.QueryRow(ctx, `select depth = 1 and status = 'listed' and members = 1 and listed_at = $2
				and (select count(*) from members where archive_id = $1) = 1
				and exists (select 1 from members where archive_id = $1 and path = 'original.txt')
				from archives where content_id = $1`, id, listed).Scan(&valid); err != nil || !valid {
				t.Fatalf("rolled back cache: valid=%v, %v", valid, err)
			}
			if sc.Counts.Archives != 1 || sc.Counts.Members != 1 {
				t.Fatalf("rollback counts: %+v", sc.Counts)
			}
		})
	}
}

func TestArchiveCacheKeepsListingWhenUpgradeIsIncomplete(t *testing.T) {
	for _, res := range []archive.Result{{Status: archive.Split}, {Status: archive.Listed, Incomplete: true}} {
		t.Run(fmt.Sprint(res), func(t *testing.T) {
			sc, conn, id := archiveCacheScan(t)
			ctx := t.Context()
			finishArchiveListing(t, sc, id, 1, "original.txt")
			l, err := sc.StartListing(ctx, id, 2)
			if err != nil || l == nil {
				t.Fatalf("upgrade: %v, %v", l, err)
			}
			defer l.Abort(ctx)
			if err := l.Finish(ctx, res); err != nil {
				t.Fatal(err)
			}
			var valid bool
			if err := conn.QueryRow(ctx, `select depth = 1 and status = 'listed' and members = 1
		and exists (select 1 from members where archive_id = $1 and path = 'original.txt')
		from archives where content_id = $1`, id).Scan(&valid); err != nil || !valid {
				t.Fatalf("unsuccessful upgrade replaced valid cache: %t, %v", valid, err)
			}
			if sc.Counts.Archives != 1 || sc.Counts.Members != 1 {
				t.Fatalf("unsuccessful upgrade changed counts: %+v", sc.Counts)
			}
		})
	}
}

func TestLegacyArchiveListingRequiresExplicitRebuild(t *testing.T) {
	sc, conn, id := archiveCacheScan(t)
	ctx := t.Context()
	finishArchiveListing(t, sc, id, 2, "nested.zip :: deep.txt")
	if _, err := conn.Exec(ctx, `update archives set depth = null where content_id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if n, err := sc.ArchiveTotals(ctx, []config.ArchiveScope{{Path: "/", Depth: 3}}); err != nil || n != 0 {
		t.Fatalf("legacy cache queued for automatic replacement: %d, %v", n, err)
	}
	if l, err := sc.StartListing(ctx, id, 3); err != nil || l != nil {
		if l != nil {
			l.Abort(ctx)
		}
		t.Fatalf("legacy cache claimed: %v, %v", l, err)
	}
	var retained bool
	if err := conn.QueryRow(ctx, `select depth is null
		and exists (select 1 from members where archive_id = $1 and path = 'nested.zip :: deep.txt')
		from archives where content_id = $1`, id).Scan(&retained); err != nil || !retained {
		t.Fatalf("legacy nested members were lost: %t, %v", retained, err)
	}
	if err := sc.RebuildContent(ctx); err != nil {
		t.Fatal(err)
	}
	finishArchiveListing(t, sc, id, 3, "refreshed.txt")
}

func TestArchiveQueueUsesEachFolderPolicy(t *testing.T) {
	sc, conn, id := archiveCacheScan(t)
	ctx := t.Context()
	finishArchiveListing(t, sc, id, 1)
	if _, err := conn.Exec(ctx, `with folders as (
		insert into entries (volume_id, parent_id, kind, name, raw_name, path, hash_state, first_scan, updated_scan)
		select $1, (select id from entries where volume_id=$1 and path=''), 'dir', path, convert_to(path, 'UTF8'), path, 'none', $3, $3
		from unnest(array['/DEEP/disabled', '/deep/disabled/open', '/foo', '/foobar', '/blocked']) as path
		returning id, path
	)
	insert into entries
		(volume_id, parent_id, kind, name, raw_name, path, ext, size_bytes, content_id, hash_state, first_scan, updated_scan)
	select $1, id, 'file', 'copy.zip', 'copy.zip'::bytea, path || '/copy.zip', 'zip', 10, $2, 'done', $3, $3 from folders`, sc.Volume.ID, id, sc.ID); err != nil {
		t.Fatal(err)
	}
	scopes := []config.ArchiveScope{
		{Path: "/deep/disabled/open", Depth: 2},
		{Path: "/", Depth: 2},
		{Path: "/deep", Depth: 2},
		{Path: "/deep/disabled", Depth: 0},
		{Path: "/shallow", Depth: 1},
		{Path: "/foo", Depth: 0},
		{Path: "/blocked", Depth: 0},
	}
	for _, cached := range []bool{true, false} {
		if !cached {
			if _, err := conn.Exec(ctx, `delete from archives where content_id = $1`, id); err != nil {
				t.Fatal(err)
			}
		}
		if n, err := sc.ArchiveTotals(ctx, scopes); err != nil || n != 1 {
			t.Fatalf("cached %t totals: %d, %v", cached, n, err)
		}
		var paths []string
		var after store.PendingArchive
		for {
			page, err := sc.NextArchives(ctx, after, 1, scopes)
			if err != nil {
				t.Fatal(err)
			}
			if len(page) == 0 {
				break
			}
			after = page[0]
			paths = append(paths, after.Path)
		}
		want := []string{"/deep/copy.zip", "/deep/disabled/open/copy.zip", "/foobar/copy.zip"}
		if !cached {
			want = append(want, "/shallow/copy.zip")
		}
		if !slices.Equal(paths, want) {
			t.Fatalf("cached %t queue paths: %v, want %v", cached, paths, want)
		}
	}
}
