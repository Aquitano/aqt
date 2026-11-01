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
	data := zipOf(t, map[string]string{"nested.zip": zipOf(t, map[string]string{"deep.txt": "content"})})
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
