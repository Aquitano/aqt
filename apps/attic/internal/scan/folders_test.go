package scan

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestFolderConfigReadRefusesLinksAndOversizedFiles(t *testing.T) {
	root := t.TempDir()
	folders := config.NewFolders(root, config.Default().Rules("", ""))
	write(t, root, config.FolderFile, strings.Repeat(" ", (64<<10)+1))
	if _, err := folders.Load("", nil); err == nil {
		t.Fatal("oversized folder config accepted")
	}
	other := filepath.Join(t.TempDir(), "policy.toml")
	if err := os.Rename(filepath.Join(root, config.FolderFile), other); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(root, config.FolderFile)); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := folders.Load("", nil); err == nil {
		t.Fatal("followed a linked folder config")
	}
}

func TestFolderArchivePolicyKeepsHashAndMetadata(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATTIC_SCAN_METADATA_HELPER", "1")
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, config.FolderFile, "[archives]\ndepth = 0\n")
	write(t, root, "backups/closed.zip", zipOf(t, map[string]string{"hidden.txt": "hidden"}))
	write(t, root, "backups/photo.png", "image")
	write(t, root, "backups/notes.txt", "ordinary document text")
	cfg := config.Config{Archives: config.Archives{Depth: 2}, Metadata: config.Metadata{Enabled: true, ExifTool: binary, MaxBytes: 1 << 20}, Temp: t.TempDir()}
	options := func(o *Options) {
		o.Config = cfg
		o.Path = filepath.Join(root, "backups")
		o.locate = func(string) (disk.Volume, []string, error) {
			return disk.Volume{Fingerprint: testVolume, Root: root}, []string{"backups"}, nil
		}
	}
	res := scanAt(t, st, root, testVolume, options)
	if res.Counts.Archives != 0 || res.Phases.Archives != 0 || res.Counts.Metadata != 1 || res.Counts.Texts != 1 {
		t.Fatalf("disabled archives changed other processing or ran the archive phase: %+v", res)
	}
	closed := find(t, st, "closed.zip")
	if closed.Ref == "" || closed.Size == 0 || closed.Modified == nil {
		t.Fatalf("closed archive lost its hash or filesystem metadata: %+v", closed)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from members where name='hidden.txt'`); n != 0 {
		t.Fatal("read members of the closed archive")
	}
	write(t, root, "backups/open/.attic.toml", "[archives]\ndepth = 1\n")
	write(t, root, "backups/open/listed.zip", zipOf(t, map[string]string{"visible.txt": "visible"}))
	cfg.Archives.Depth = 0
	res = scanAt(t, st, root, testVolume, options)
	if res.Counts.Archives != 1 {
		t.Fatalf("deeper folder did not enable one archive: %+v", res.Counts)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from members where name='visible.txt'`); n != 1 {
		t.Fatal("deeper folder did not re-enable archive listing")
	}
}

func TestUnreadableFolderDoesNotProcessQueuedContent(t *testing.T) {
	for _, noHash := range []bool{true, false} {
		t.Run(fmt.Sprint(noHash), func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			write(t, root, "blocked/archive.zip", zipOf(t, map[string]string{"hidden.txt": "hidden"}))
			scanAt(t, st, root, testVolume, func(o *Options) { o.NoHash = noHash })
			write(t, root, "blocked/.attic.toml", "[archives]\ndepth = 0\n")
			res := scanAt(t, st, root, testVolume, func(o *Options) {
				o.Config.Archives.Depth = 2
				o.list = func(dir string) ([]disk.Entry, error) {
					if dir == filepath.Join(root, "blocked") {
						return nil, fs.ErrPermission
					}
					return disk.List(dir)
				}
			})
			if res.Counts.Hashed != 0 || res.Counts.Archives != 0 || pgschematest.QueryInt(t, dsn, `select count(*) from members`) != 0 {
				t.Fatalf("unresolved policy allowed content processing: %+v", res.Counts)
			}
		})
	}
}

func TestFolderDepthUpgradesIdenticalArchiveCopies(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	data := zipOf(t, map[string]string{"fake.zip": "ordinary bytes", "nested.zip": zipOf(t, map[string]string{"deep.txt": "content"})})
	write(t, root, "a/copy.zip", data)
	write(t, root, "a/.attic.toml", "[archives]\ndepth = 1\n")
	write(t, root, "b/copy.zip", data)
	write(t, root, "b/.attic.toml", "[archives]\ndepth = 2\n")
	options := func(o *Options) { o.Config.Archives.Depth = 1 }
	scanAt(t, st, root, testVolume, options)
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from members where name='deep.txt'`); n != 1 {
		t.Fatal("a shallower copy prevented the deeper folder's listing")
	}
	if res := scanAt(t, st, root, testVolume, options); res.Counts.Archives != 0 {
		t.Fatalf("completed deep listing was repeated: %+v", res.Counts)
	}
}

func TestFolderPoliciesKeepCaseSensitiveSiblingsSeparate(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "A"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "a")); err == nil {
		t.Skip("this directory is case-insensitive")
	}
	st, dsn := storetest.New(t)
	write(t, root, "A/.attic.toml", "[archives]\ndepth = 0\n")
	write(t, root, "a/.attic.toml", "[archives]\ndepth = 2\n")
	write(t, root, "A/closed.zip", zipOf(t, map[string]string{"hidden.txt": "hidden"}))
	write(t, root, "a/open.zip", zipOf(t, map[string]string{"visible.txt": "visible"}))
	res := scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
	if res.Counts.Archives != 1 || pgschematest.QueryInt(t, dsn, `select count(*) from members where name = 'hidden.txt'`) != 0 ||
		pgschematest.QueryInt(t, dsn, `select count(*) from members where name = 'visible.txt'`) != 1 {
		t.Fatalf("case-sensitive sibling changed the disabled folder's policy: %+v", res.Counts)
	}
}

func TestArchiveDepthUpgradeRetainsCacheAfterNestedSkip(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	deepest := zipOf(t, map[string]string{"deep.txt": "content", "closed.zip": zipOf(t, map[string]string{"unopened.txt": "content"})})
	nested := zipOf(t, map[string]string{"cached.txt": "cached", "deeper.zip": deepest})
	write(t, root, "copy.zip", zipOf(t, map[string]string{"nested.zip": nested}))
	options := func(o *Options) { o.Config.Archives.Depth = 2 }
	scanAt(t, st, root, testVolume, options)
	res := scanAt(t, st, root, testVolume, func(o *Options) {
		o.Config.Archives.Depth = 3
		o.Config.Archives.UnpackMaxBytes = 1
	})
	if res.Counts.Archives != 0 || res.Counts.Members != 0 ||
		pgschematest.QueryInt(t, dsn, `select depth from archives`) != 2 ||
		pgschematest.QueryInt(t, dsn, `select count(*) from archive_depth_failures where unpack_max_bytes = 1`) != 1 ||
		pgschematest.QueryInt(t, dsn, `select count(*) from members where name = 'cached.txt'`) != 1 {
		t.Fatalf("nested skip replaced the cache: %+v", res.Counts)
	}
	res = scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 3 })
	if res.Counts.Archives != 1 || pgschematest.QueryInt(t, dsn, `select depth from archives`) != 3 ||
		pgschematest.QueryInt(t, dsn, `select count(*) from members where name in ('cached.txt', 'deep.txt')`) != 2 {
		t.Fatalf("successful retry did not deepen the cache: %+v", res.Counts)
	}
}

func TestSatisfiedFolderDepthSkipsArchiveTransaction(t *testing.T) {
	r := run{rules: config.Default().Rules("", "")}
	if err := r.listArchive(t.Context(), store.PendingArchive{Path: "/copy.zip", Depth: r.rules.ArchiveDepth}); err != nil {
		t.Fatal(err)
	}
}

func TestArchiveDepthUpgradeRemembersUnchangedUnpackLimit(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	small := zipOf(t, map[string]string{"small.txt": "cached"})
	large := zipOf(t, map[string]string{"large.txt": strings.Repeat("larger", 10000)})
	if len(large) <= len(small) {
		t.Fatal("large fixture must exceed the small archive's size")
	}
	write(t, root, "copy.zip", zipOf(t, map[string]string{"a.zip": small, "z.zip": large}))
	scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
	for i, limit := range []int64{int64(len(small)), int64(len(small)), 0} {
		res := scanAt(t, st, root, testVolume, func(o *Options) {
			o.Config.Archives.Depth = 2
			o.Config.Archives.UnpackMaxBytes = limit
		})
		wantSkips := 0
		if i == 0 {
			wantSkips = 1
		}
		if skips, err := st.Skips(t.Context(), res.ScanID, "too_big", "", 10); err != nil || len(skips) != wantSkips {
			t.Fatalf("attempt %d at limit %d: %+v, %v", i, limit, skips, err)
		}
		wantDepth, wantArchives := int64(1), int64(0)
		if limit == 0 {
			wantDepth, wantArchives = 2, 1
		}
		if res.Counts.Archives != wantArchives || pgschematest.QueryInt(t, dsn, `select depth from archives`) != wantDepth {
			t.Fatalf("attempt %d at limit %d: %+v", i, limit, res.Counts)
		}
	}
	if pgschematest.QueryInt(t, dsn, `select count(*) from members where name in ('small.txt', 'large.txt')`) != 2 {
		t.Fatal("changed unpack limit did not restore both nested listings")
	}
}

func TestArchiveUpgradeRemembersPermanentFailuresAtEachDepth(t *testing.T) {
	encrypted, err := os.ReadFile(filepath.Join("..", "archive", "testdata", "encrypted.7z"))
	if err != nil {
		t.Fatal(err)
	}
	whole := zipOf(t, map[string]string{"whole.txt": "content"})
	for _, tc := range []struct {
		name, nested, reason string
	}{
		{"encrypted", string(encrypted), "encrypted"},
		{"damaged", whole[:len(whole)-10], "damaged"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			data := zipOf(t, map[string]string{"nested.zip": zipOf(t, map[string]string{"cached.txt": "cached", "closed.zip": tc.nested})})
			for _, name := range []string{"a/first.zip", "a/second.zip", "b/copy.zip"} {
				write(t, root, name, data)
			}
			scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
			write(t, root, "a/.attic.toml", "[archives]\ndepth = 3\n")
			write(t, root, "b/.attic.toml", "[archives]\ndepth = 2\n")
			for i, want := range []int{1, 0, 1} {
				if i == 2 {
					scanAt(t, st, root, testVolume, func(o *Options) {
						o.Path = filepath.Join(root, "b")
						o.locate = func(string) (disk.Volume, []string, error) {
							return disk.Volume{Fingerprint: testVolume, Root: root}, []string{"b"}, nil
						}
						o.RebuildContent = true
					})
					if pgschematest.QueryInt(t, dsn, `select count(*) from archive_depth_failures`) != 0 {
						t.Fatal("explicit subtree rebuild kept the shared failure record")
					}
				}
				res := scanAt(t, st, root, testVolume, func(o *Options) {
					o.Config.Archives.Depth = 1
				})
				if skips, err := st.Skips(t.Context(), res.ScanID, tc.reason, "", 10); err != nil || len(skips) != want {
					t.Fatalf("scan %d permanent attempts: %+v, %v; want %d", i, skips, err, want)
				}
				if pgschematest.QueryInt(t, dsn, `select depth from archives`) != 2 ||
					pgschematest.QueryInt(t, dsn, `select count(*) from members where name='cached.txt'`) != 1 ||
					pgschematest.QueryInt(t, dsn, `select count(*) from archive_depth_failures where depth = 3`) != 1 {
					t.Fatal("failed depth-3 attempt lost its failure record or prevented a valid depth-2 upgrade")
				}
			}
		})
	}
}

func TestArchiveUpgradeRetriesUnverifiedCopies(t *testing.T) {
	for _, failure := range []string{"missing", "changed"} {
		t.Run(failure, func(t *testing.T) {
			st, dsn := storetest.New(t)
			root := t.TempDir()
			data := zipOf(t, map[string]string{"nested.zip": zipOf(t, map[string]string{"deep.txt": "content"})})
			write(t, root, "a.zip", data)
			write(t, root, "b.zip", data)
			scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
			changed := false
			res := scanAt(t, st, root, testVolume, func(o *Options) {
				o.Config.Archives.Depth = 2
				o.Progress = func(p Progress) {
					if p.Phase != "archives" || changed {
						return
					}
					changed = true
					if failure == "missing" {
						if err := os.Remove(filepath.Join(root, "a.zip")); err != nil {
							t.Fatal(err)
						}
					} else {
						write(t, root, "a.zip", data[:len(data)-1]+"x")
					}
				}
			})
			if !changed || res.Counts.Archives != 1 || pgschematest.QueryInt(t, dsn, `select depth from archives`) != 2 ||
				pgschematest.QueryInt(t, dsn, `select count(*) from archive_depth_failures`) != 0 ||
				pgschematest.QueryInt(t, dsn, `select count(*) from members where name='deep.txt'`) != 1 {
				t.Fatalf("unverified copy blocked a valid upgrade: changed %t, counts %+v", changed, res.Counts)
			}
		})
	}
}

func TestArchiveListingRetriesCopiesWithMissingVolumes(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	for _, folder := range []string{"a", "b"} {
		write(t, root, folder+"/test.part01.rar", rarFixture(t, "test.part01.rar"))
	}
	write(t, root, "b/test.part02.rar", rarFixture(t, "test.part02.rar"))
	res := scanAt(t, st, root, testVolume, func(o *Options) {
		o.Config.Archives.Depth = 1
	})
	if res.Counts.Archives != 2 ||
		pgschematest.QueryInt(t, dsn, `select count(*) from archives where status='listed'`) != 1 ||
		pgschematest.QueryInt(t, dsn, `select count(*) from members`) == 0 {
		t.Fatalf("missing volume prevented a complete copy from listing: %+v", res.Counts)
	}
}

func TestArchiveUpgradeRetriesCopiesWithDamagedVolumes(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	for _, folder := range []string{"a", "b"} {
		for _, name := range []string{"test.part01.rar", "test.part02.rar"} {
			write(t, root, folder+"/"+name, rarFixture(t, name))
		}
	}
	scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 1 })
	bad := []byte(rarFixture(t, "test.part02.rar"))
	bad[0] ^= 0xff
	write(t, root, "a/test.part02.rar", string(bad))
	res := scanAt(t, st, root, testVolume, func(o *Options) { o.Config.Archives.Depth = 2 })
	if res.Counts.Members == 0 || pgschematest.QueryInt(t, dsn, `select depth from archives where content_id =
		(select content_id from entries where path = '/a/test.part01.rar')`) != 2 ||
		pgschematest.QueryInt(t, dsn, `select count(*) from archive_depth_failures`) != 0 {
		t.Fatalf("damaged volume prevented a complete copy from upgrading: %+v", res.Counts)
	}
}
