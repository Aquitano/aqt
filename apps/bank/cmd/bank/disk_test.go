package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// disks is archive with a catalogue of one volume, which is not attached
// here: /Files/a.txt and /Backup/a.txt hold the same content, and
// /Files/b.txt is not hashed yet.
func disks(t *testing.T) *httptest.Server {
	t.Helper()
	dsn, _, remote := archive(t)
	const volume = "00000000-0000-0000-0000-000000000001"
	storetest.Exec(t, dsn, `
  insert into volumes(id,label,fs_type,serial,stable_ids) values ('`+volume+`','Archive','TEST','1',true);
  insert into scans(id,volume_id,root,status) overriding system value values (1,'`+volume+`','','complete');
  insert into contents(blake3,size_bytes) values (decode(repeat('ab',32),'hex'),5);
  insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,first_scan,updated_scan) overriding system value values
   (1,'`+volume+`',null,'dir','',''::bytea,'',0,null,'none',1,1),
   (2,'`+volume+`',1,'dir','Files','Files'::bytea,'/Files',0,null,'none',1,1),
   (3,'`+volume+`',1,'dir','Backup','Backup'::bytea,'/Backup',0,null,'none',1,1),
   (4,'`+volume+`',2,'file','a.txt','a.txt'::bytea,'/Files/a.txt',5,(select id from contents where blake3 = decode(repeat('ab',32),'hex')),'done',1,1),
   (5,'`+volume+`',3,'file','a.txt','a.txt'::bytea,'/Backup/a.txt',5,(select id from contents where blake3 = decode(repeat('ab',32),'hex')),'done',1,1),
   (6,'`+volume+`',2,'file','b.txt','b.txt'::bytea,'/Files/b.txt',7,null,'pending',1,1)`)
	return remote
}

func TestDiskCommandsAnswerTheSameInProcessAndOverHTTP(t *testing.T) {
	remote := disks(t)
	for want, args := range map[string][]string{
		`"status":"unavailable"`: {"disk", "verify", "--volume", "Archive", "--under", "/Files", "--json"},
		"set aside  Archive:":    {"disk", "dedupe", "plan", "--volume", "Archive", "--keep", "/Files", "--min-size", "0"},
	} {
		local, overHTTP, localErr, httpErr := runBoth(t, remote, args...)
		if local != overHTTP || !strings.Contains(local, want) || (localErr == nil) != (httpErr == nil) || (localErr != nil && localErr.Error() != httpErr.Error()) {
			t.Errorf("%v differs:\nin process (%v):\n%s\nover HTTP (%v):\n%s", args, localErr, local, httpErr, overHTTP)
		}
	}
}

// With BANK_URL set, the disk commands reach the catalogue only through it:
// a command that opened DATABASE_URL here would fail to connect.
func TestDiskCommandsDoNotOpenTheDatabaseThroughBankURL(t *testing.T) {
	remote := disks(t)
	t.Setenv("BANK_URL", remote.URL)
	t.Setenv("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:1/none?sslmode=disable&connect_timeout=1")
	to := filepath.Join(t.TempDir(), "a.txt")
	for _, tc := range []struct {
		args []string
		err  string
	}{
		{args: []string{"disk", "volumes"}},
		{args: []string{"disk", "scans", "--volume", "Archive"}},
		{args: []string{"disk", "skips"}},
		{args: []string{"disk", "dupes", "--min-size", "0"}},
		{args: []string{"disk", "redundancy", "--volume", "Archive", "--under", "/Files"}},
		{args: []string{"disk", "search", "a"}},
		{args: []string{"disk", "entry", "4"}},
		{args: []string{"disk", "analysis", "4", "--json"}},
		{args: []string{"disk", "dedupe", "plan", "--volume", "Archive", "--keep", "/Files", "--min-size", "0"}},
		{args: []string{"disk", "dedupe", "apply", "--volume", "Archive", "--keep", "/Files", "--min-size", "0"}},
		{args: []string{"disk", "verify", "--volume", "Archive", "--under", "/Files"}, err: "did not match every selected file"},
		{args: []string{"disk", "get", "4", "--to", to}, err: "no usable online copy"},
		{args: []string{"disk", "enrich", "4", "--task", "describe", "--provider", "openai", "--model", "vision"}, err: "no selected catalogue volumes are online"},
		{args: []string{"show", "content:abababababababab"}},
		{args: []string{"stats"}},
	} {
		_, err := printed(t, tc.args...)
		if tc.err == "" && err != nil || tc.err != "" && (err == nil || !strings.Contains(err.Error(), tc.err)) {
			t.Errorf("%v: %v, want %q", tc.args, err, tc.err)
		}
	}
}
