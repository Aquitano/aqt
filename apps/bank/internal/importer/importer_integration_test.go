package importer_test

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importer/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

// lines is a source that reads one message per line, "id|date|body|file,
// file". A date of - is unknown. While broken is set it fails after
// emitting its first message, the way a parser bug or a crash ends an import
// between storing attachment bytes and writing rows.
type lines struct{ broken *atomic.Bool }

func (lines) Kind() string { return "lines" }

func (l lines) Parse(_ context.Context, raw ingest.Raw, _ struct{}, out ingest.Emitter) error {
	f, err := raw.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for n := 0; scanner.Scan(); n++ {
		if n == 1 && l.broken.Load() {
			return errors.New("parser bug")
		}
		fields := strings.Split(scanner.Text(), "|")
		m := ingest.Message{Source: "lines", ExternalID: fields[0], ThreadID: "thread", Body: fields[2]}
		if fields[1] != "-" {
			if m.SentAt, err = time.Parse(time.DateOnly, fields[1]); err != nil {
				return err
			}
		}
		for _, name := range strings.Split(fields[3], ",") {
			if name != "" {
				m.Parts = append(m.Parts, ingest.Part{Filename: name, Open: func() (io.ReadCloser, error) {
					return io.NopCloser(strings.NewReader("bytes of " + name)), nil
				}})
			}
		}
		if err := out.Message(m); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func setup(t *testing.T, input string) (importer.Target, string, string, *atomic.Bool) {
	t.Helper()
	st, dsn := storetest.NewNamed(t)
	broken := &atomic.Bool{}
	target := importtest.On(t, st, importer.Register(lines{broken: broken}, "Test lines."))
	path := filepath.Join(t.TempDir(), "input.txt")
	if err := os.WriteFile(path, []byte(input), 0o600); err != nil {
		t.Fatal(err)
	}
	return target, dsn, path, broken
}

const threeMessages = "a|2024-05-01|first|a.pdf,b.pdf\nb|2024-05-02|second|c.pdf\nc|-|undated|\n"

func replay(t *testing.T, target importer.Target) store.RawInput {
	t.Helper()
	var got []store.RawInput
	err := importer.Replay(context.Background(), target, nil, func(r store.RawInput, err error) {
		if err != nil {
			t.Fatalf("replay %d: %v", r.ID, err)
		}
		got = append(got, r)
	})
	if err != nil || len(got) != 1 {
		t.Fatalf("replay: %+v %v", got, err)
	}
	return got[0]
}

// An import that stops after storing attachment bytes leaves no row behind,
// keeps its input, and replays completely once the parser is fixed.
func TestFailedImportLeavesNoPartialMessageAndReplays(t *testing.T) {
	target, dsn, path, broken := setup(t, threeMessages)
	broken.Store(true)
	failed, err := importtest.Import(t, target, "lines", path, nil)
	if err == nil || failed.Status != "failed" || !strings.Contains(failed.Error, "parser bug") {
		t.Fatalf("broken parse: %+v %v", failed, err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages`); n != 0 {
		t.Fatalf("%d messages written by a failed import", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from raw_inputs where status = 'failed'`); n != 1 {
		t.Fatalf("the rejected input was not kept: %d", n)
	}

	broken.Store(false)
	got := replay(t, target)
	if got.ID != failed.ID || got.Status != "complete" || got.Report.Inserted != 3 || got.Report.Attachments != 3 {
		t.Fatalf("replay after the fix: %+v", got)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages m where m.external_id = 'a'
		and (select count(*) from attachments a where a.message_id = m.id) = 2`); n != 1 {
		t.Fatal("message a is missing attachments")
	}
}

func TestImportingTwiceWritesOneSetOfRows(t *testing.T) {
	target, dsn, path, _ := setup(t, threeMessages)
	first := importtest.MustImport(t, target, "lines", path, nil)
	again := importtest.MustImport(t, target, "lines", path, nil)
	if first.ID != again.ID || again.Report.Inserted != 0 || again.Report.Duplicates != 3 || again.Report.Attachments != 0 {
		t.Fatalf("second import: %+v", again)
	}
	storetest.Exec(t, dsn, `delete from messages`)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if _, err := importtest.Import(t, target, "lines", path, nil); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages`); n != 3 {
		t.Fatalf("%d messages, want 3", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from attachments`); n != 3 {
		t.Fatalf("%d attachments, want 3", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from raw_inputs`); n != 1 {
		t.Fatalf("%d raw inputs, want 1", n)
	}
}

// An undated message is stored without a date and sorts before every dated
// one: first in a thread read oldest first.
func TestUndatedMessageIsNullAndSortsFirst(t *testing.T) {
	target, dsn, path, _ := setup(t, threeMessages)
	importtest.MustImport(t, target, "lines", path, nil)
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where sent_at is null`); n != 1 {
		t.Fatalf("%d undated messages, want 1", n)
	}
	thread, err := target.Store.GetThreadPage(context.Background(), "lines", "thread", store.ThreadOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, m := range thread.Messages {
		order = append(order, m.ExternalID)
	}
	if strings.Join(order, ",") != "c,a,b" || !thread.Messages[0].SentAt.IsZero() {
		t.Fatalf("thread order %v", order)
	}
	stats, err := target.Store.Stats(context.Background())
	if err != nil || len(stats) != 1 || stats[0].Undated != 1 || stats[0].Earliest.Format(time.DateOnly) != "2024-05-01" {
		t.Fatalf("stats: %+v %v", stats, err)
	}
}

func TestRetiredMessagesStayRetiredOnReplay(t *testing.T) {
	target, dsn, path, _ := setup(t, threeMessages)
	importtest.MustImport(t, target, "lines", path, nil)
	if _, err := target.Store.RetireMessages(context.Background(), store.RetireOptions{Source: "lines", ExternalPrefixes: []string{"a"}, Apply: true}); err != nil {
		t.Fatal(err)
	}
	got := replay(t, target)
	if got.Report.Retired != 1 || got.Report.Duplicates != 2 || got.Report.Inserted != 0 {
		t.Fatalf("replay: %+v", got.Report)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages`); n != 2 {
		t.Fatalf("%d messages after replay, want 2", n)
	}
}
