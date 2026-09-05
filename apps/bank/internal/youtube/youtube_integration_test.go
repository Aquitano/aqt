package youtube

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt-bank/internal/storetest"
)

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
	st, schema := storetest.NewNamed(t)
	archiveDir := filepath.Join(t.TempDir(), "archive")

	res, err := Import(ctx, st, archiveDir, takeoutZip(t, historyJSON))
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 4 || res.Duplicates != 0 {
		t.Errorf("res = %+v, want the four non-ad records", res)
	}
	if res.Ads != 1 {
		t.Errorf("ads = %d, want the Google Ads impression dropped", res.Ads)
	}
	if res.Channels != 2 {
		t.Errorf("channels = %d, want the two named channels", res.Channels)
	}

	// The channel is the thread, so one lookup returns everything watched from
	// it — with the video title as the subject and the watch URL as the body.
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

	// The archive keeps the history file, not the Takeout it arrived in: the
	// mail beside it is another source's data, and a full export is gigabytes.
	entries, err := os.ReadDir(filepath.Join(archiveDir, "youtube"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("archive holds %d files, want only the history", len(entries))
	}
	if got := entries[0].Name(); !strings.HasSuffix(got, "-watch-history.json") {
		t.Errorf("archived as %q, want a content-hashed watch-history.json", got)
	}
	if n := storetest.QueryInt(t, schema,
		`select count(*) from messages where raw_ref = $1`, filepath.Join("youtube", entries[0].Name())); n != 4 {
		t.Errorf("%d messages cite the archived history, want 4", n)
	}
}

// HTML is what a default-configured Takeout writes, so the whole path gets one
// end-to-end pass: the lookup finding the .html, the extension dispatch, and
// the archive keeping the file under its own name.
func TestImportFromAnHTMLTakeout(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	archiveDir := filepath.Join(t.TempDir(), "archive")

	res, err := Import(ctx, st, archiveDir, takeoutZipFiles(t, map[string]string{htmlHistoryPath: historyHTML}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 3 || res.Ads != 1 {
		t.Errorf("res = %+v, want the three watches kept and the ad dropped", res)
	}
	entries, err := os.ReadDir(filepath.Join(archiveDir, "youtube"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), "-watch-history.html") {
		t.Errorf("archive = %v, want one content-hashed watch-history.html", entries)
	}
}

// An export configured for "Multiple formats" carries both; the JSON is the
// one read, being the richer format.
func TestJSONWinsWhenAnExportCarriesBoth(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	res, err := Import(ctx, st, filepath.Join(t.TempDir(), "archive"),
		takeoutZipFiles(t, map[string]string{historyPath: historyJSON, htmlHistoryPath: historyHTML}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 4 {
		t.Errorf("res = %+v, want the JSON fixture's four records, not the HTML's three", res)
	}
}

// The point of the whole importer: Takeout exports on a schedule overlap, and
// re-reading one must not double the archive. A repeat watch of the same video
// is a different event and does survive.
func TestReimportKeepsOneRowPerWatchEvent(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	archiveDir := filepath.Join(t.TempDir(), "archive")

	first := takeoutZip(t, historyJSON)
	if _, err := Import(ctx, st, archiveDir, first); err != nil {
		t.Fatal(err)
	}
	res, err := Import(ctx, st, archiveDir, first)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 0 || res.Duplicates != 4 {
		t.Errorf("res = %+v, want every record recognized as already archived", res)
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
	res, err = Import(ctx, st, archiveDir, takeoutZip(t, repeat))
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 1 || res.Duplicates != 1 {
		t.Errorf("res = %+v, want the second watch kept and the re-export ignored", res)
	}
}

// Google has changed the sub-second precision of the time field between export
// generations; the same event must still hash to the same id.
func TestSubSecondPrecisionDoesNotSplitAnEvent(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	archiveDir := filepath.Join(t.TempDir(), "archive")

	record := func(time string) string {
		return `[{"header":"YouTube","title":"Watched Rust in 100 Seconds",
			"titleUrl":"https://www.youtube.com/watch?v=5C_HPTJg5ek",
			"time":"` + time + `"}]`
	}
	if _, err := Import(ctx, st, archiveDir, takeoutZip(t, record("2026-08-14T09:12:33.123456Z"))); err != nil {
		t.Fatal(err)
	}
	res, err := Import(ctx, st, archiveDir, takeoutZip(t, record("2026-08-14T09:12:33Z")))
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 0 || res.Duplicates != 1 {
		t.Errorf("res = %+v, want the same event under a coarser timestamp", res)
	}
}

func TestImportFromAnUnpackedTakeoutAndABareHistoryFile(t *testing.T) {
	ctx := context.Background()
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
			st := storetest.New(t)
			res, err := Import(ctx, st, filepath.Join(t.TempDir(), "archive"), input)
			if err != nil {
				t.Fatal(err)
			}
			if res.Inserted != 4 {
				t.Errorf("res = %+v, want the four non-ad records", res)
			}
		})
	}
}

func TestImportRejectsSomethingThatIsNotAHistoryExport(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.json"), []byte(`[]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Import(ctx, st, filepath.Join(t.TempDir(), "archive"), dir); err == nil {
		t.Fatal("a directory with no watch history should not import as one")
	}
}
