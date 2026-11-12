package scan

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
	"lukechampine.com/blake3"
)

func TestDerivedContentUsesHashedBytes(t *testing.T) {
	for _, ext := range []string{"txt", "zip"} {
		t.Run(ext, func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			original, replacement := "original", "replaced"
			if ext == "zip" {
				original = zipOf(t, map[string]string{"original.txt": "original"})
				replacement = zipOf(t, map[string]string{"replaced.txt": "replaced"})
			}
			if len(original) != len(replacement) {
				t.Fatal("replacement must have the same size")
			}
			write(t, root, "a."+ext, original)
			write(t, root, "b."+ext, original)
			changed := false
			first := scanAt(t, st, root, testVolume, func(o *Options) {
				o.Config.Temp = t.TempDir()
				o.Config.Archives.Depth = 1
				o.Progress = func(p Progress) {
					if p.Phase == "hash" && p.Hashed == 2 && !changed {
						changed = true
						write(t, root, "a."+ext, replacement)
					}
				}
			})
			if !changed {
				t.Fatal("replacement did not happen after hashing")
			}
			if skips, err := st.Skips(t.Context(), first.ScanID, "changed", "", 10); err != nil || len(skips) != 1 {
				t.Fatalf("changed copies: %+v, %v", skips, err)
			}
			for range 2 {
				if ext == "txt" {
					got, err := st.Text(t.Context(), find(t, st, "b.txt").ID, "")
					if err != nil || got.Text != "original" {
						t.Fatalf("unchanged copy text: %+v, %v", got, err)
					}
				} else if n := pgschematest.QueryInt(t, dsn, `select count(*) from members m join entries e on e.content_id=m.archive_id where e.path='/b.zip' and m.name='original.txt'`); n != 1 {
					t.Fatalf("unchanged copy has %d original members", n)
				}
				scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
			}
		})
	}
}

func TestNonArchiveSkipDoesNotCacheUnverifiedBytes(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "fake.zip", "not an archive")
	res := scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
	skips, err := st.Skips(t.Context(), res.ScanID, "not_archive", "", 10)
	if err != nil || len(skips) != 1 {
		t.Fatalf("skips: %+v, %v", skips, err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from archives`); n != 0 {
		t.Fatalf("cached %d unverified archive results", n)
	}
}

func TestRebuildContentIsScopedAndPreservesOtherCaches(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "selected/a.txt", "original words")
	write(t, root, "outside/copy.txt", "original words")
	write(t, root, "outside/b.txt", "outside words")
	write(t, root, "selected/gone.txt", "missing words")
	write(t, root, "selected/a.zip", zipOf(t, map[string]string{"original.txt": "data"}))
	write(t, root, "outside/b.zip", zipOf(t, map[string]string{"outside.txt": "data"}))
	first := scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
	if err := os.Remove(filepath.Join(root, "selected", "gone.txt")); err != nil {
		t.Fatal(err)
	}
	pgschematest.QueryInt(t, dsn, `with changed as (update texts set text='poisoned' returning 1) select count(*) from changed`)
	pgschematest.QueryInt(t, dsn, `with changed as (update members set name='poisoned.txt' returning 1) select count(*) from changed`)
	metadataRows := pgschematest.QueryInt(t, dsn, `with added as (insert into metadata(content_id,status,tags) select id,'ok','{}'::jsonb from contents returning 1) select count(*) from added`)
	aiRows := pgschematest.QueryInt(t, dsn, `with added as (insert into ai_results(content_id,task,provider,model,prompt_version,status,text) select id,'ocr','test','test','test','ok','keep' from contents returning 1) select count(*) from added`)
	result := scanAt(t, st, root, testVolume, func(o *Options) {
		o.Path = filepath.Join(root, "selected")
		o.locate = func(string) (disk.Volume, []string, error) {
			return disk.Volume{Fingerprint: testVolume, Root: root}, []string{"selected"}, nil
		}
		o.Config.Temp = t.TempDir()
		o.Config.Archives.Depth = 1
		o.RebuildContent = true
	})
	if result.Counts.Hashed != 0 || result.Counts.Texts != 1 || result.Counts.Archives != 1 || result.Volume.ID != first.Volume.ID {
		t.Fatalf("rebuild counts: %+v", result)
	}
	text, err := st.Text(t.Context(), find(t, st, "copy.txt").ID, "")
	if err != nil || text.Text != "original words" {
		t.Fatalf("shared copy did not receive rebuilt text: %+v, %v", text, err)
	}
	for _, tc := range []struct {
		query string
		want  int64
	}{
		{`select count(*) from texts where text='poisoned'`, 2},
		{`select count(*) from members where name='poisoned.txt'`, 1},
		{`select count(*) from members where name='original.txt'`, 1},
		{`select count(*) from metadata`, metadataRows},
		{`select count(*) from ai_results where text='keep'`, aiRows},
	} {
		if got := pgschematest.QueryInt(t, dsn, tc.query); got != tc.want {
			t.Errorf("%s: %d, want %d", tc.query, got, tc.want)
		}
	}
}

func TestRebuildContentWaitsForListingsAndCancelsAtomically(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a.txt", "retained text")
	first := scanAt(t, st, root, testVolume)
	sc, err := st.StartScan(t.Context(), first.Volume, "")
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Finish(context.Background(), "complete", nil)
	id := pgschematest.QueryInt(t, dsn, `select content_id from entries where path='/a.txt'`)
	listing, err := sc.StartListing(t.Context(), id, 1, 0)
	if err != nil || listing == nil {
		t.Fatalf("listing: %v", err)
	}
	defer listing.Abort(t.Context())
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if err := sc.RebuildContent(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("rebuild while listing: %v", err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from texts where text='retained text'`); n != 1 {
		t.Fatalf("cancelled rebuild retained %d texts", n)
	}
	listing.Abort(t.Context())
	if err := sc.RebuildContent(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from texts`); n != 0 {
		t.Fatalf("retry retained %d texts", n)
	}
}

func rarFixture(t *testing.T, name string) string {
	t.Helper()
	encoded, err := os.ReadFile(filepath.Join("testdata", "rar", name+".base64"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := base64.StdEncoding.DecodeString(string(encoded))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestMultipartArchivesVerifySiblingsAndPreserveNames(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprintf("changed=%t", changed), func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			for _, name := range []string{"test.part01.rar", "test.part02.rar"} {
				write(t, root, name, rarFixture(t, name))
			}
			cfg := config.Config{Temp: t.TempDir(), Archives: config.Archives{Depth: 1}}
			first := scanAt(t, st, root, testVolume, func(o *Options) {
				o.Config = cfg
				if changed {
					o.Progress = func(p Progress) {
						if p.Phase == "hash" && p.Hashed == 2 {
							part := []byte(rarFixture(t, "test.part02.rar"))
							part[len(part)/2] ^= 1
							write(t, root, "test.part02.rar", string(part))
						}
					}
				}
			})
			want := int64(2)
			if changed {
				want = 1
			}
			if first.Counts.Archives != want {
				t.Fatalf("listed %d archives, want %d", first.Counts.Archives, want)
			}
			if !changed {
				if n := pgschematest.QueryInt(t, dsn, `select count(*) from archives where status='split'`); n != 1 {
					t.Fatalf("later part has %d split outcomes", n)
				}
				if n := pgschematest.QueryInt(t, dsn, `select count(*) from members`); n == 0 {
					t.Fatal("multipart archive has no members")
				}
			} else {
				write(t, root, "test.part02.rar", rarFixture(t, "test.part02.rar"))
				if again := scanAt(t, st, root, testVolume, func(o *Options) { o.Config = cfg }); again.Counts.Archives != 1 {
					t.Fatalf("restored parts did not retry: %+v", again.Counts)
				}
			}
			left, err := filepath.Glob(filepath.Join(cfg.Temp, "aqt-attic", "scan-*"))
			if err != nil || len(left) != 0 {
				t.Fatalf("scratch remains: %v, %v", left, err)
			}
		})
	}
}

func TestScanRejectsRebuildWithoutHashing(t *testing.T) {
	_, err := Run(t.Context(), nil, Options{NoHash: true, RebuildContent: true})
	if err == nil {
		t.Fatal("rebuild without hashing accepted")
	}
}

func TestFileSystemWithoutChangeTimesRehashesBeforeReading(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a.txt", "original words")
	scanAt(t, st, root, testVolume)
	// A digest that no longer describes the file, as a same-size rewrite that
	// kept its modified time would leave on exFAT.
	pgschematest.QueryInt(t, dsn, `with stale as (update contents set blake3 = decode(repeat('ab', 32), 'hex') returning 1) select count(*) from stale`)
	pgschematest.QueryInt(t, dsn, `with gone as (delete from texts returning 1) select count(*) from gone`)
	res := scanAt(t, st, root, testVolume)
	if res.Counts.Texts != 0 {
		t.Fatalf("read text under a stale digest: %+v", res.Counts)
	}
	if skips, err := st.Skips(t.Context(), res.ScanID, "changed", "", 10); err != nil || len(skips) != 1 {
		t.Fatalf("changed skips: %+v, %v", skips, err)
	}
}

func TestRewriteThenRenameRehashesBeforeDerivedContent(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATTIC_SCAN_METADATA_HELPER", "1")
	for _, ext := range []string{"txt", "zip", "mp4"} {
		t.Run(ext, func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			original, replacement := "original", "replaced"
			if ext == "zip" {
				original = zipOf(t, map[string]string{"original.txt": "original"})
				replacement = zipOf(t, map[string]string{"replaced.txt": "replaced"})
			}
			if len(original) != len(replacement) {
				t.Fatal("replacement must have the same size")
			}
			write(t, root, "moving.bin", original)
			path := filepath.Join(root, "moving.bin")
			before, err := disk.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if before.Changed.IsZero() {
				t.Skip("filesystem has no change time")
			}
			fp := testVolume
			fp.FS = "NTFS"
			cfg := config.Config{Temp: t.TempDir(), Archives: config.Archives{Depth: 1}, Metadata: config.Metadata{Enabled: true, ExifTool: binary}}
			scanAt(t, st, root, fp, func(o *Options) { o.Config = cfg })
			old := find(t, st, "moving")
			oldContent := pgschematest.QueryInt(t, dsn, `select content_id from entries where id=$1`, old.ID)
			write(t, root, "moving.bin", replacement)
			if err := os.Chtimes(path, before.Modified, before.Modified); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(path, filepath.Join(root, "moving."+ext)); err != nil {
				t.Fatal(err)
			}
			res := scanAt(t, st, root, fp, func(o *Options) { o.Config = cfg })
			after := find(t, st, "moving")
			digest := blake3.Sum256([]byte(replacement))
			if res.Counts.Hashed != 1 || after.ID != old.ID || after.Ref != fmt.Sprintf("%x", digest[:8]) || after.Ref == old.Ref {
				t.Fatalf("replacement kept old digest: before %+v, after %+v, counts %+v", old, after, res.Counts)
			}
			if n := pgschematest.QueryInt(t, dsn, `select
				(select count(*) from texts where content_id=$1) +
				(select count(*) from metadata where content_id=$1) +
				(select count(*) from archives where content_id=$1)`, oldContent); n != 0 {
				t.Fatalf("stored %d replacement results under the original digest", n)
			}
			if res.Counts.Texts+res.Counts.Archives+res.Counts.Metadata != 1 {
				t.Fatalf("replacement was not extracted: %+v", res.Counts)
			}
			if again := scanAt(t, st, root, fp, func(o *Options) { o.Config = cfg }); again.Counts.Hashed != 0 {
				t.Fatalf("unchanged NTFS file rehashed: %+v", again.Counts)
			}
		})
	}
}

func TestLegacyHashProvenanceBeforeDirectExtraction(t *testing.T) {
	for _, fs := range []string{"NTFS", "ReFS"} {
		for _, ext := range []string{"txt", "zip"} {
			for _, stale := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/stale=%t", fs, ext, stale), func(t *testing.T) {
					st, dsn := storetest.New(t)
					root := t.TempDir()
					original, replacement := "original", "replaced"
					if ext == "zip" {
						original = zipOf(t, map[string]string{"original.txt": "original"})
						replacement = zipOf(t, map[string]string{"replaced.txt": "replaced"})
					}
					if len(original) != len(replacement) {
						t.Fatal("replacement must have the same size")
					}
					fp := testVolume
					fp.FS = fs
					write(t, root, "moving.bin", original)
					scanAt(t, st, root, fp)
					old := find(t, st, "moving")
					before, err := disk.Stat(filepath.Join(root, "moving.bin"))
					if err != nil {
						t.Fatal(err)
					}
					if stale {
						write(t, root, "moving.bin", replacement)
						if err := os.Chtimes(filepath.Join(root, "moving.bin"), before.Modified, before.Modified); err != nil {
							t.Fatal(err)
						}
					}
					path := filepath.Join(root, "moving."+ext)
					if err := os.Rename(filepath.Join(root, "moving.bin"), path); err != nil {
						t.Fatal(err)
					}
					now, err := disk.Stat(path)
					if err != nil {
						t.Fatal(err)
					}
					if now.Changed.IsZero() {
						t.Skip("filesystem has no change time")
					}
					// Old ApplyListing acknowledged the rename's new stamp without hashing.
					pgschematest.QueryInt(t, dsn, `update entries set name=$2, raw_name=convert_to($2,'UTF8'),
						path='/' || $2, ext=$3, modified_at=$4, changed_at=$5, hash_trusted=false
						where id=$1 and hash_state='done' returning id`, old.ID, "moving."+ext, ext,
						now.Modified.Truncate(time.Microsecond), now.Changed.Truncate(time.Microsecond))
					res := scanAt(t, st, root, fp, func(o *Options) { o.Config.Archives.Depth = 1 })
					want := int64(1)
					if stale {
						want = 0
					}
					if res.Counts.Hashed != 0 || res.Counts.Texts+res.Counts.Archives != want {
						t.Fatalf("legacy extraction: %+v, want %d results without rehashing", res.Counts, want)
					}
					if after := find(t, st, "moving"); after.Ref != old.Ref {
						t.Fatalf("legacy baseline changed: %s to %s", old.Ref, after.Ref)
					}
					if n := pgschematest.QueryInt(t, dsn, `select count(*) from entries where hash_trusted`); n != 0 {
						t.Fatalf("promoted %d legacy hashes", n)
					}
					if ext == "txt" && !stale {
						got, err := st.Text(t.Context(), old.ID, "")
						if err != nil || got.Text != original {
							t.Fatalf("legacy text: %+v, %v", got, err)
						}
					}
					if ext == "zip" && !stale {
						if n := pgschematest.QueryInt(t, dsn, `select count(*) from members where name='original.txt'`); n != 1 {
							t.Fatalf("correct legacy archive has %d original members", n)
						}
					}
					if n := pgschematest.QueryInt(t, dsn, `select
						(select count(*) from texts where text='replaced') +
						(select count(*) from members where name='replaced.txt')`); n != 0 {
						t.Fatalf("attached %d replacement results to the old digest", n)
					}
				})
			}
		}
	}
}
