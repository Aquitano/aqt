package archive

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func zipOf(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range slices.Sorted(maps.Keys(files)) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(files[name]); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func tarGzOf(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func list(t *testing.T, data []byte, o Options) (Result, []Member, []Skip) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "archive")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var members []Member
	var skips []Skip
	res, err := List(context.Background(), p, os.Open, o,
		func(m Member) error { members = append(members, m); return nil },
		func(s Skip) { skips = append(skips, s) })
	if err != nil {
		t.Fatal(err)
	}
	return res, members, skips
}

func TestListOpensNestedArchivesToTheDepth(t *testing.T) {
	deepest := zipOf(t, map[string][]byte{"x.txt": []byte("x")})
	server := zipOf(t, map[string][]byte{"server.properties": []byte("motd=hi"), "deeper.zip": deepest})
	// A gzipped log is one compressed file, not an archive to open.
	var log bytes.Buffer
	gz := gzip.NewWriter(&log)
	if _, err := gz.Write([]byte("joined")); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	outer := zipOf(t, map[string][]byte{"world/level.dat": []byte("level"), "MinecraftServer.zip": server, "logs/latest.log.gz": log.Bytes()})
	temp := t.TempDir()

	res, members, skips := list(t, outer, Options{Depth: 2, Temp: temp})
	if res.Status != Listed || res.Format != "zip" {
		t.Fatalf("result %+v", res)
	}
	var paths []string
	for _, m := range members {
		paths = append(paths, m.Path)
	}
	want := []string{"MinecraftServer.zip", "MinecraftServer.zip :: deeper.zip", "MinecraftServer.zip :: server.properties", "logs/latest.log.gz", "world/level.dat"}
	if !slices.Equal(paths, want) {
		t.Errorf("members %q, want %q", paths, want)
	}
	if len(skips) != 1 || skips[0].Path != "MinecraftServer.zip :: deeper.zip" || skips[0].Reason != "too_deep" {
		t.Errorf("skips %+v, want deeper.zip too deep", skips)
	}
	if left, _ := os.ReadDir(temp); len(left) != 0 {
		t.Errorf("temporary copies left behind: %v", left)
	}

	_, _, skips = list(t, outer, Options{Depth: 2, UnpackMaxBytes: 10, Temp: temp})
	if len(skips) != 1 || skips[0].Reason != "too_big" {
		t.Errorf("skips with a 10-byte cap %+v, want MinecraftServer.zip too big", skips)
	}
}

func TestListTellsWhyAnArchiveCannotBeRead(t *testing.T) {
	encrypted, err := os.ReadFile(filepath.Join("testdata", "encrypted.7z"))
	if err != nil {
		t.Fatal(err)
	}
	whole := zipOf(t, map[string][]byte{"a.txt": []byte("a")})
	cases := []struct {
		name   string
		data   []byte
		status string
		format string
	}{
		{"tar.gz", tarGzOf(t, "backup/notes.txt", []byte("notes")), Listed, "tar.gz"},
		{"truncated zip", whole[:len(whole)-10], Damaged, "zip"},
		{"7z with encrypted names", encrypted, Encrypted, "7z"},
		{"text named .zip", []byte("not an archive at all"), NotArchive, ""},
	}
	for _, tc := range cases {
		res, members, _ := list(t, tc.data, Options{Depth: 1})
		if res.Status != tc.status || res.Format != tc.format {
			t.Errorf("%s: %s %q (%s), want %s %q", tc.name, res.Status, res.Format, res.Detail, tc.status, tc.format)
		}
		if tc.status == Listed && (len(members) != 1 || members[0].Path != "backup/notes.txt") {
			t.Errorf("%s: members %+v", tc.name, members)
		}
	}
}

// Windows writes zip names in code page 850 without the UTF-8 flag, macOS and
// Info-ZIP write UTF-8 without it; both must come out readable.
func TestZipNamesWithoutTheUTF8Flag(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"\x9aber.txt", "Übung.txt"} {
		if _, err := zw.CreateHeader(&zip.FileHeader{Name: name, NonUTF8: true}); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	_, members, _ := list(t, buf.Bytes(), Options{Depth: 1})
	if len(members) != 2 || members[0].Name != "Über.txt" || members[1].Name != "Übung.txt" {
		t.Errorf("members %+v, want Über.txt and Übung.txt", members)
	}
}

// A later volume of a split rar is recognised by name before a byte is read;
// RAR4 parts give rardecode no way to tell.
func TestLaterRarVolumesAreSplit(t *testing.T) {
	p := filepath.Join(t.TempDir(), "Backup.part02.rar")
	if err := os.WriteFile(p, []byte("continuation"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := List(context.Background(), p, os.Open, Options{Depth: 1}, func(Member) error { return nil }, func(Skip) {})
	if err != nil || res.Status != Split {
		t.Errorf("part02: %+v, %v; want split", res, err)
	}
}
