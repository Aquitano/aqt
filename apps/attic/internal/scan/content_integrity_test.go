package scan

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
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
	listing, err := sc.StartListing(t.Context(), id)
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

func TestArchiveSiblingCopiesAreRemovedOnClose(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "first.rar", "first")
	write(t, root, "second.rar", "second")
	first := scanAt(t, st, root, testVolume)
	sc, err := st.StartScan(t.Context(), first.Volume, "")
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Finish(context.Background(), "complete", nil)
	w, err := scratch.New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	r := &run{sc: sc, mountRoot: root, log: slog.New(slog.DiscardHandler)}
	c := archiveCopies{r: r, w: w, ctx: t.Context(), source: filepath.Join(root, "first.rar")}
	f, err := c.open(filepath.Join(root, "second.rar"))
	if err != nil {
		t.Fatal(err)
	}
	write(t, root, "second.rar", "mutated")
	data := make([]byte, len("second"))
	if _, err := f.ReadAt(data, 0); err != nil || string(data) != "second" {
		t.Fatalf("snapshot changed: %q, %v", data, err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(w.Path)
	if err != nil || len(files) != 1 || c.failure != nil {
		t.Fatalf("closed copies remain: %v, %v, %v", files, err, c.failure)
	}
}

func TestScanRejectsRebuildWithoutHashing(t *testing.T) {
	_, err := Run(t.Context(), nil, Options{NoHash: true, RebuildContent: true})
	if err == nil {
		t.Fatal("rebuild without hashing accepted")
	}
}
