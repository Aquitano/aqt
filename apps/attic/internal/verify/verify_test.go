package verify

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/jackc/pgx/v5"
	"lukechampine.com/blake3"
)

func testMount(t *testing.T) disk.Volume {
	t.Helper()
	root := t.TempDir()
	m := disk.Volume{}
	if runtime.GOOS == "windows" {
		var err error
		m, _, err = disk.Locate(root)
		if err != nil {
			t.Fatal(err)
		}
	}
	m.Root = root
	return m
}

func TestRereadIgnoresUnchangedMetadata(t *testing.T) {
	m := testMount(t)
	p := filepath.Join(m.Root, "file")
	if err := os.WriteFile(p, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(p, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	digest := blake3.Sum256([]byte("before"))
	f := store.VerifyFile{ID: 1, Kind: "file", Path: "/file", HashState: "done", Digest: digest[:]}
	if r := readOne(t.Context(), m, f); r.Status != "matched" {
		t.Fatalf("%+v", r)
	}
	if err := os.WriteFile(p, []byte("after!"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil || info.Size() != 6 || !info.ModTime().Equal(stamp) {
		t.Fatalf("metadata: %v, %v", info, err)
	}
	r := readOne(t.Context(), m, f)
	if r.Status != "mismatched" || r.Expected == r.Actual || r.Bytes != 6 {
		t.Fatalf("%+v", r)
	}
	if !bytes.Equal(f.Digest, digest[:]) {
		t.Fatal("baseline changed")
	}
	if got, err := os.ReadFile(p); err != nil || string(got) != "after!" {
		t.Fatalf("source changed: %q, %v", got, err)
	}
}

func TestReadOutcomes(t *testing.T) {
	m := testMount(t)
	digest := blake3.Sum256(nil)
	for _, tc := range []struct {
		name, path, kind, state, want string
		offline                       bool
	}{
		{"missing", "/absent", "file", "done", "missing", false},
		{"read error", "/bad\x00", "file", "done", "unreadable", false},
		{"unhashed", "/absent", "file", "pending", "unknown", false},
		{"link", "/absent", "link", "none", "unavailable", false},
		{"offline", "/absent", "file", "done", "unavailable", true},
		{"escape", "/../outside", "file", "done", "unavailable", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mount := m
			if tc.offline {
				mount.Root = ""
			}
			r := readOne(t.Context(), mount, store.VerifyFile{Path: tc.path, Kind: tc.kind, HashState: tc.state, Digest: digest[:]})
			if r.Status != tc.want || r.Detail == "" {
				t.Fatalf("%+v", r)
			}
		})
	}
}

func TestVolumeIdentityNeedsExplicitAmbiguityDecision(t *testing.T) {
	m := disk.Volume{Fingerprint: disk.Fingerprint{FS: "TEST", Serial: "one", DeviceSerial: "hardware"}}
	v := store.Volume{ID: "id", FS: m.FS, Serial: m.Serial, DeviceSerial: m.DeviceSerial}
	if id, err := MatchVolume(m, []store.Volume{v}, ""); err != nil || id != v.ID {
		t.Fatalf("%s: %v", id, err)
	}
	for _, device := range []string{"", "clone"} {
		m.DeviceSerial = device
		if _, err := MatchVolume(m, []store.Volume{v}, ""); err == nil {
			t.Fatal("accepted ambiguous disk")
		}
		if _, err := MatchVolume(m, []store.Volume{v}, v.ID); err != nil {
			t.Fatal(err)
		}
	}
	m.Serial = "different"
	if _, err := MatchVolume(m, []store.Volume{v}, v.ID); err == nil {
		t.Fatal("accepted different serial")
	}
	m.Serial, m.DeviceSerial = v.Serial, v.DeviceSerial
	if _, err := MatchVolume(m, []store.Volume{v, v}, ""); err == nil {
		t.Fatal("accepted multiple matches")
	}
}

func TestCatalogueVerificationScopeAndBaseline(t *testing.T) {
	st, dsn := storetest.New(t)
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	const volume = "00000000-0000-0000-0000-000000000001"
	_, err = conn.Exec(ctx, `
insert into volumes(id,fs_type,serial,stable_ids) values ('00000000-0000-0000-0000-000000000001','TEST','one',false);
insert into scans(id,volume_id,root,status) overriding system value values (1,'00000000-0000-0000-0000-000000000001','','complete');
insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,hash_state,first_scan,updated_scan) overriding system value values
(1,'00000000-0000-0000-0000-000000000001',null,'dir','',''::bytea,'','none',1,1),
(2,'00000000-0000-0000-0000-000000000001',1,'file','changed','changed'::bytea,'/files/changed','done',1,1),
(3,'00000000-0000-0000-0000-000000000001',1,'file','missing','missing'::bytea,'/files/missing','done',1,1),
(4,'00000000-0000-0000-0000-000000000001',1,'file','unknown','unknown'::bytea,'/files/unknown','pending',1,1),
(5,'00000000-0000-0000-0000-000000000001',1,'file','other','other'::bytea,'/files-other/copy','done',1,1),
(6,'00000000-0000-0000-0000-000000000001',1,'file','match','match'::bytea,'/files/match','done',1,1);`)
	if err != nil {
		t.Fatal(err)
	}
	digest := blake3.Sum256([]byte("before"))
	var content int64
	if err := conn.QueryRow(ctx, `insert into contents(blake3,size_bytes) values($1,6) returning id`, digest[:]).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `update entries set content_id=$1 where hash_state='done'`, content); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `update entries set missing_scan=1 where id=3`); err != nil {
		t.Fatal(err)
	}
	m := testMount(t)
	if err := os.Mkdir(filepath.Join(m.Root, "files"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"changed": "after!", "match": "before"} {
		if err := os.WriteFile(filepath.Join(m.Root, "files", name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var results []Result
	summary, err := Run(ctx, st, volume, "/files", m, func(r Result) error { results = append(results, r); return nil })
	if err == nil || !summary.Complete || summary.Matched != 1 || summary.Mismatched != 1 || summary.Missing != 1 || summary.Unknown != 1 || len(results) != 4 {
		t.Fatalf("%+v, %v; %+v", summary, err, results)
	}
	var unchanged bool
	if err := conn.QueryRow(ctx, `select c.blake3=$1 and e.content_id=$2 and e.hash_state='done' from entries e join contents c on c.id=e.content_id where e.id=2`, digest[:], content).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("baseline changed: %v", err)
	}
	summary, err = Run(ctx, st, volume, "/unknown", m, func(r Result) error { return nil })
	if err == nil || !summary.Complete || summary.Unknown != 1 {
		t.Fatalf("unknown scope: %+v, %v", summary, err)
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	summary, err = Run(cancelCtx, st, volume, "/files", m, func(r Result) error { cancel(); return nil })
	if !errors.Is(err, context.Canceled) || summary.Complete || summary.Mismatched != 1 {
		t.Fatalf("partial: %+v, %v", summary, err)
	}
}
