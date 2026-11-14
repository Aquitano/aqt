package main

import (
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

// archive is a migrated database and data directory with one message that
// carries an attachment, imported by the CLI in process. It answers the
// message's ref and a bank serve over a socket on the same archive.
func archive(t *testing.T) (dsn, cited string, remote *httptest.Server) {
	t.Helper()
	dsn, dir := storetest.Migrated(t), t.TempDir()
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("BANK_DATA_DIR", dir)
	t.Setenv("BANK_QUERY_DATABASE_URL", "")
	t.Setenv("BANK_URL", "")
	input := filepath.Join(dir, "notes.json")
	entry := `{"source":"notes","external_id":"n1","thread":"ideas","sender":"me","body":"lunch plans","sent_at":"2024-05-01 12:00:00",` +
		`"attachments":[{"filename":"plan.txt","mime_type":"text/plain","data":"cGxhbg=="}]}`
	if err := os.WriteFile(input, []byte(entry), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := printed(t, "import", "json", input); err != nil {
		t.Fatal(err)
	}
	if err := storetest.Pool(t, dsn).QueryRow(t.Context(), `select ref from messages`).Scan(&cited); err != nil {
		t.Fatal(err)
	}

	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(storetest.Open(t, dsn), attic.New(storetest.OpenCatalogue(t, dsn), ""), blobs, dir, sources.All)
	token, err := server.Tokens(dir).New("cli-test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	remote = httptest.NewServer(srv.Handler())
	t.Cleanup(remote.Close)
	t.Setenv("BANK_TOKEN", token)
	return dsn, cited, remote
}

// printed executes a command and returns what it printed on stdout.
func printed(t *testing.T, args ...string) (string, error) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = w
	out := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		out <- string(b)
	}()
	err = execute(t.Context(), args)
	os.Stdout = stdout
	w.Close()
	return <-out, err
}

// runBoth runs a command in process, then against bank serve over a socket.
func runBoth(t *testing.T, remote *httptest.Server, args ...string) (local, overHTTP string, localErr, httpErr error) {
	t.Helper()
	t.Setenv("BANK_URL", "")
	local, localErr = printed(t, args...)
	t.Setenv("BANK_URL", remote.URL)
	overHTTP, httpErr = printed(t, args...)
	t.Setenv("BANK_URL", "")
	return local, overHTTP, localErr, httpErr
}

func TestCommandsAnswerTheSameInProcessAndOverHTTP(t *testing.T) {
	_, cited, remote := archive(t)

	local, overHTTP, localErr, httpErr := runBoth(t, remote, "show", cited, "--json")
	if localErr != nil || httpErr != nil || local != overHTTP || local == "" {
		t.Fatalf("show --json differs:\nin process (%v):\n%s\nover HTTP (%v):\n%s", localErr, local, httpErr, overHTTP)
	}
	_, _, localErr, httpErr = runBoth(t, remote, "show", "msg:ffffffffffffffff")
	if localErr == nil || httpErr == nil || localErr.Error() != httpErr.Error() {
		t.Fatalf("a missing ref failed as %v in process and %v over HTTP", localErr, httpErr)
	}
	_, _, localErr, httpErr = runBoth(t, remote, "search", "lunch", "--offset", "20000")
	if localErr == nil || httpErr == nil || localErr.Error() != httpErr.Error() {
		t.Fatalf("an invalid parameter failed as %v in process and %v over HTTP", localErr, httpErr)
	}
}

// The import queued a text job for the attachment, and nothing in the
// command's process took it.
func TestInProcessServerRunsNoJobs(t *testing.T) {
	dsn, _, _ := archive(t)
	var queued, attempted int
	if err := storetest.Pool(t, dsn).QueryRow(t.Context(),
		`select count(*), count(attempted_at) from river_job`).Scan(&queued, &attempted); err != nil {
		t.Fatal(err)
	}
	if queued == 0 || attempted != 0 {
		t.Fatalf("%d jobs queued, %d attempted; want the text job queued and never attempted", queued, attempted)
	}
}
