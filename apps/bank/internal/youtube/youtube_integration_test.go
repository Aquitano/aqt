package youtube

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

var kind = importer.Register(Source{}, "YouTube watch history")

// historyPath is where a Takeout puts the file, product folder and all, so the
// tests exercise the lookup rather than a flat directory. htmlHistoryPath is
// its sibling in a default-configured (HTML) export.
const (
	historyPath     = "Takeout/YouTube and YouTube Music/history/watch-history.json"
	htmlHistoryPath = "Takeout/YouTube and YouTube Music/history/watch-history.html"
)

func takeoutZip(t *testing.T, body string) string {
	return takeoutZipFiles(t, map[string]string{historyPath: body})
}

func takeoutZipFiles(t *testing.T, histories map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "takeout-20260823T214653Z-1-001.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	// A Takeout carries every exported product at once; only the history is
	// this importer's business.
	files := map[string]string{
		"Takeout/YouTube and YouTube Music/history/search-history.json": `[{"header":"YouTube","title":"Searched for rust"}]`,
		"Takeout/Mail/All mail Including Spam and Trash.mbox":           "From a@example.com Mon May 13 21:08:00 2024\n",
	}
	for name, content := range histories {
		files[name] = content
	}
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestImportFromTakeoutZip(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	target := importtest.On(t, st, kind)

	got := importtest.MustImport(t, target, "youtube", takeoutZip(t, historyJSON), nil)
	if got.Report.Inserted != 4 || got.Report.Duplicates != 0 {
		t.Errorf("report = %+v, want the four non-ad records", got.Report)
	}
	if got.Report.Issues[ingest.Dropped] != 1 || got.Status != "complete" {
		t.Errorf("report = %+v status %s, want the Google Ads impression dropped and the import complete", got.Report, got.Status)
	}

	// The channel is the thread, so one lookup returns everything watched from
	// it, with the video title as the subject and the watch URL as the body.
	th, err := st.GetThread(ctx, "youtube", "UCsBjURrPoezykLs9EqgamOA", 0)
	if err != nil {
		t.Fatalf("no thread for the channel id: %v", err)
	}
	if len(th.Messages) != 1 {
		t.Fatalf("thread = %+v, want the one video watched from that channel", th.Messages)
	}
	m := th.Messages[0]
	if m.Subject != "Rust in 100 Seconds" || m.Sender != "Fireship" {
		t.Errorf("message = %+v, want the video title and its channel", m)
	}
	if m.Body != "https://www.youtube.com/watch?v=5C_HPTJg5ek" {
		t.Errorf("body = %q, want the watch URL", m.Body)
	}
	if n := pgschematest.QueryInt(t, dsn,
		`select count(*) from messages where raw_input_id = $1 and raw_locator = 'watch-history.json'`, got.ID); n != 4 {
		t.Errorf("%d messages cite the Takeout's history file, want 4", n)
	}
}

// HTML is what a default-configured Takeout writes, so the whole path gets one
// end-to-end pass: the lookup finding the .html and the extension dispatch.
func TestImportFromAnHTMLTakeout(t *testing.T) {
	target := importtest.Target(t, kind)

	got := importtest.MustImport(t, target, "youtube", takeoutZipFiles(t, map[string]string{htmlHistoryPath: historyHTML}), nil)
	if got.Report.Inserted != 3 || got.Report.Issues[ingest.Dropped] != 1 {
		t.Errorf("report = %+v, want the three watches kept and the ad dropped", got.Report)
	}
}

// An export configured for "Multiple formats" carries both; the JSON is the
// one read, being the richer format.
func TestJSONWinsWhenAnExportCarriesBoth(t *testing.T) {
	target := importtest.Target(t, kind)

	got := importtest.MustImport(t, target, "youtube",
		takeoutZipFiles(t, map[string]string{historyPath: historyJSON, htmlHistoryPath: historyHTML}), nil)
	if got.Report.Inserted != 4 {
		t.Errorf("report = %+v, want the JSON fixture's four records, not the HTML's three", got.Report)
	}
}

// The point of the whole importer: Takeout exports on a schedule overlap, and
// re-reading one must not double the archive. A repeat watch of the same video
// is a different event and does survive.
func TestReimportKeepsOneRowPerWatchEvent(t *testing.T) {
	target := importtest.Target(t, kind)

	first := takeoutZip(t, historyJSON)
	importtest.MustImport(t, target, "youtube", first, nil)
	got := importtest.MustImport(t, target, "youtube", first, nil)
	if got.Report.Inserted != 0 || got.Report.Duplicates != 4 {
		t.Errorf("report = %+v, want every record recognized as already archived", got.Report)
	}

	// A later export repeats the overlap and adds one more watch of a video
	// already in the archive, at a new time.
	repeat := `[
	 {"header":"YouTube","title":"Watched Rust in 100 Seconds",
	  "titleUrl":"https://www.youtube.com/watch?v=5C_HPTJg5ek",
	  "subtitles":[{"name":"Fireship","url":"https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA"}],
	  "time":"2026-08-20T20:00:00Z"},
	 {"header":"YouTube","title":"Watched Rust in 100 Seconds",
	  "titleUrl":"https://www.youtube.com/watch?v=5C_HPTJg5ek",
	  "subtitles":[{"name":"Fireship","url":"https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA"}],
	  "time":"2026-08-14T09:12:33.123Z"}
	]`
	got = importtest.MustImport(t, target, "youtube", takeoutZip(t, repeat), nil)
	if got.Report.Inserted != 1 || got.Report.Duplicates != 1 {
		t.Errorf("report = %+v, want the second watch kept and the re-export ignored", got.Report)
	}
}

// Google has changed the sub-second precision of the time field between export
// generations; the same event must still hash to the same id.
func TestSubSecondPrecisionDoesNotSplitAnEvent(t *testing.T) {
	target := importtest.Target(t, kind)

	record := func(time string) string {
		return `[{"header":"YouTube","title":"Watched Rust in 100 Seconds",
			"titleUrl":"https://www.youtube.com/watch?v=5C_HPTJg5ek",
			"time":"` + time + `"}]`
	}
	importtest.MustImport(t, target, "youtube", takeoutZip(t, record("2026-08-14T09:12:33.123456Z")), nil)
	got := importtest.MustImport(t, target, "youtube", takeoutZip(t, record("2026-08-14T09:12:33Z")), nil)
	if got.Report.Inserted != 0 || got.Report.Duplicates != 1 {
		t.Errorf("report = %+v, want the same event under a coarser timestamp", got.Report)
	}
}

func TestImportFromAnUnpackedTakeoutAndABareHistoryFile(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, filepath.FromSlash(historyPath))
	if err := os.MkdirAll(filepath.Dir(nested), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nested, []byte(historyJSON), 0o600); err != nil {
		t.Fatal(err)
	}

	for name, input := range map[string]string{
		"unpacked takeout":  filepath.Join(dir, "Takeout"),
		"bare history file": nested,
	} {
		t.Run(name, func(t *testing.T) {
			got := importtest.MustImport(t, importtest.Target(t, kind), "youtube", input, nil)
			if got.Report.Inserted != 4 {
				t.Errorf("report = %+v, want the four non-ad records", got.Report)
			}
		})
	}
}

func TestImportRejectsSomethingThatIsNotAHistoryExport(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.json"), []byte(`[]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := importtest.Import(t, importtest.Target(t, kind), "youtube", dir, nil); err == nil {
		t.Fatal("a directory with no watch history should not import as one")
	}
}
