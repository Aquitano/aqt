package mediaimport

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/inbox"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/youtube"
)

var (
	netflixKind  = importer.Register(Netflix{}, "Netflix viewing activity")
	youtubeKind  = importer.Register(YouTube{}, "YouTube Takeout")
	bundleKind   = importer.Register(Bundle{}, "Library bundle")
	markdownKind = importer.Register(Markdown{}, "Markdown publication")
)

func fixture(t *testing.T, root, name, body string) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

type recorder struct {
	batch  library.ImportBatch
	issues []ingest.Issue
}

func (r *recorder) Message(ingest.Message) error { return errors.New("unexpected message") }
func (r *recorder) Library(b library.ImportBatch) error {
	r.batch = b
	return nil
}
func (r *recorder) Pages(ingest.Pages) error { return errors.New("unexpected pages") }
func (r *recorder) Issue(issue ingest.Issue) { r.issues = append(r.issues, issue) }

func (r *recorder) count(kind ingest.IssueKind) int {
	n := 0
	for _, issue := range r.issues {
		if issue.Kind == kind {
			n++
		}
	}
	return n
}

func parse[O any](src ingest.Source[O], path string, opts O) (*recorder, error) {
	if n, ok := any(&opts).(ingest.Normalizer); ok {
		if err := n.Normalize(); err != nil {
			return nil, err
		}
	}
	rec := &recorder{}
	return rec, src.Parse(context.Background(), ingest.Raw{Name: filepath.Base(path), Path: path}, opts, rec)
}

func mustParse[O any](t *testing.T, src ingest.Source[O], path string, opts O) *recorder {
	t.Helper()
	rec, err := parse(src, path, opts)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func writeZip(t *testing.T, files map[string]string) string {
	t.Helper()
	var raw bytes.Buffer
	zw := zip.NewWriter(&raw)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return fixture(t, t.TempDir(), "takeout.zip", raw.String())
}

func publish(t *testing.T, target importer.Target, publication Publication) (int64, error) {
	t.Helper()
	raw, err := json.Marshal(publication)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := importtest.Import(t, target, "markdown", fixture(t, t.TempDir(), "publication.json", string(raw)), nil)
	return stored.ID, err
}

func TestNetflixDatesAndExactReplayIdentity(t *testing.T) {
	path := fixture(t, t.TempDir(), "viewing.csv", "Title,Date\nA Film,9/19/26\nA Film,9/19/26\nShow: Season 2: A Day,2026-09-18\nUndated,\nBroken,not-a-date\n")
	opts := NetflixOptions{Account: "profile-a"}
	first := mustParse(t, Netflix{}, path, opts)
	second := mustParse(t, Netflix{}, path, opts)
	if !reflect.DeepEqual(first.batch, second.batch) {
		t.Fatal("same export changed identities")
	}
	if len(first.batch.Activity) != 4 || first.count(ingest.Skipped) != 1 || len(first.batch.Items) != 3 {
		t.Fatalf("wrong counts: %+v", first)
	}
	if first.batch.Activity[0].Occurred != (library.Date{Value: "2026-09-19", Precision: "day"}) {
		t.Fatalf("lost day precision: %+v", first.batch.Activity[0])
	}
	if first.batch.Activity[0].ID == first.batch.Activity[1].ID {
		t.Fatal("collapsed duplicate rows")
	}
	if first.batch.Activity[3].Occurred.Precision != "unknown" {
		t.Fatal("invented an unknown date")
	}
	if first.batch.Items[1].Kind != "episode" || first.batch.Items[1].Series != "Show" || *first.batch.Items[1].Season != 2 {
		t.Fatalf("episode metadata: %+v", first.batch.Items[1])
	}
	for _, item := range first.batch.Items {
		if item.State.Status != "" || item.ProviderID != "" {
			t.Fatal("inferred completion or native identity")
		}
	}
	opts.Account = "profile-b"
	other := mustParse(t, Netflix{}, path, opts)
	if other.batch.Activity[0].ID == first.batch.Activity[0].ID {
		t.Fatal("merged accounts")
	}
}

func TestNetflixOverlappingExportsPreserveMultiplicity(t *testing.T) {
	root := t.TempDir()
	firstPath := fixture(t, root, "first.csv", "Title,Date\nA Film,9/19/26\nA Film,9/19/26\nOther,9/18/26\n")
	secondPath := fixture(t, root, "second.csv", "Title,Date\nNew,9/20/26\nOther,9/18/26\nA Film,9/19/26\nA Film,9/19/26\nA Film,9/19/26\n")
	first := mustParse(t, Netflix{}, firstPath, NetflixOptions{})
	second := mustParse(t, Netflix{}, secondPath, NetflixOptions{})
	for i, j := range []int{2, 3, 1} {
		if first.batch.Activity[i].ID != second.batch.Activity[j].ID {
			t.Fatalf("overlap changed identity: %+v %+v", first.batch.Activity[i], second.batch.Activity[j])
		}
	}
	if second.batch.Activity[4].ID == second.batch.Activity[3].ID || second.batch.Activity[2].Provenance != (library.Provenance{Locator: "second.csv: CSV row 4"}) {
		t.Fatal("lost extra occurrence or its exported row")
	}
}

func TestNetflixDateOrder(t *testing.T) {
	path := fixture(t, t.TempDir(), "viewing.csv", "Title,Date\nAmbiguous,3/4/26\nDay first,19/9/2026\nISO,2026-09-18\n")
	parsed := mustParse(t, Netflix{}, path, NetflixOptions{DateOrder: "dmy"})
	if len(parsed.batch.Activity) != 3 || parsed.batch.Activity[0].Occurred.Value != "2026-04-03" || parsed.batch.Activity[1].Occurred.Value != "2026-09-19" {
		t.Fatalf("wrong day-first interpretation: %+v", parsed)
	}
	parsed = mustParse(t, Netflix{}, path, NetflixOptions{})
	if parsed.count(ingest.Skipped) != 1 || parsed.batch.Activity[0].Occurred.Value != "2026-03-04" {
		t.Fatalf("default date order changed: %+v", parsed)
	}
	if _, err := parse(Netflix{}, path, NetflixOptions{DateOrder: "auto"}); err == nil {
		t.Fatal("accepted unsupported date order")
	}
}

func TestYouTubeMixedPositions(t *testing.T) {
	for _, format := range []struct{ name, body string }{
		{"playlist.csv", "Video ID,Position\nfirst,\nsecond,0\nthird,7\nfourth,\n"},
		{"playlist.json", `{"items":[{"videoId":"first"},{"videoId":"second","position":0},{"videoId":"third","position":7},{"videoId":"fourth"}]}`},
	} {
		t.Run(format.name, func(t *testing.T) {
			parsed := mustParse(t, YouTube{}, fixture(t, t.TempDir(), format.name, format.body), YouTubeOptions{})
			for i, expected := range []int{1, 0, 7, 2} {
				if got := parsed.batch.Collections[0].Snapshot.Entries[i].Position; got != expected {
					t.Fatalf("entry %d position %d, expected %d", i, got, expected)
				}
			}
		})
	}
	for _, body := range []string{`{"items":[{"videoId":"a","position":0},{"videoId":"b","position":0}]}`, `{"items":[{"videoId":"a","position":-1}]}`} {
		if _, err := parse(YouTube{}, fixture(t, t.TempDir(), "playlist.json", body), YouTubeOptions{}); err == nil {
			t.Fatal("accepted invalid exported position")
		}
	}
}

func TestYouTubeRenamedHistoryAndPlaylistMusicClassification(t *testing.T) {
	root := t.TempDir()
	historyPath := fixture(t, root, "renamed.json", `[{"title":"Watched A","titleUrl":"https://www.youtube.com/watch?v=abc","time":"2026-09-18T12:00:00Z"}]`)
	parsed := mustParse(t, YouTube{}, historyPath, YouTubeOptions{})
	if len(parsed.batch.Activity) != 1 || len(parsed.batch.Collections) != 0 {
		t.Fatalf("history became a collection: %+v", parsed.batch)
	}
	malformedHistory := fixture(t, root, "partial.json", `[{"title":"Unreadable"},{"title":"Watched A","titleUrl":"https://www.youtube.com/watch?v=abc","time":"2026-09-18T12:00:00Z"}]`)
	if _, err := parse(YouTube{}, malformedHistory, YouTubeOptions{}); err == nil {
		t.Fatal("partly unreadable history became a collection")
	}
	for _, format := range []struct{ name, body string }{
		{"Favorite songs.csv", "Video ID,Video Title\nabc,A video\n"},
		{"Favorite songs.json", `{"items":[{"videoId":"abc","title":"A video"}]}`},
	} {
		parsed := mustParse(t, YouTube{}, fixture(t, root, format.name, format.body), YouTubeOptions{})
		if parsed.batch.Items[0].Kind != "video" || parsed.batch.Collections[0].Kind != "playlist" {
			t.Fatalf("filename inferred music: %+v", parsed.batch)
		}
	}
	musicPath := fixture(t, root, "renamed-music.csv", "Playlist ID,Title\nPL1,Saved tracks\nTrack ID,Track Title\nabc,A track\n")
	parsed = mustParse(t, YouTube{}, musicPath, YouTubeOptions{})
	if parsed.batch.Collections[0].Kind != "library" || parsed.batch.Items[0].Kind != "track" {
		t.Fatalf("explicit track metadata lost: %+v", parsed.batch)
	}
}

func TestYouTubeInputsShareByteBudget(t *testing.T) {
	path := writeZip(t, map[string]string{"playlists/a.csv": "1234", "playlists/b.csv": "5678"})
	raw := ingest.Raw{Name: filepath.Base(path), Path: path}
	if _, err := readYouTubeInputs(raw, 7); err == nil {
		t.Fatal("zip inputs exceeded aggregate budget")
	}
	if inputs, err := readYouTubeInputs(raw, 8); err != nil || len(inputs) != 2 {
		t.Fatalf("exact budget failed: %d %v", len(inputs), err)
	}
}

func TestYouTubeTakeoutZIPPreservesHistoryAndCollectionPositions(t *testing.T) {
	history := `[{"title":"Watched First","titleUrl":"https://www.youtube.com/watch?v=abc","time":"2026-09-18T12:00:00Z","subtitles":[{"name":"Creator","url":"https://www.youtube.com/channel/UC1"}]},{"title":"Watched First","titleUrl":"https://youtu.be/abc","time":"2026-09-18T13:00:00Z"},{"title":"Ad","titleUrl":"https://www.youtube.com/watch?v=ad","time":"2026-09-18T14:00:00Z","details":[{"name":"From Google Ads"}]}]`
	inputs := map[string]string{
		"Takeout/YouTube and YouTube Music/history/watch-history.json": history,
		"Takeout/YouTube and YouTube Music/history/watch-history.html": "invalid HTML should not win over JSON",
		"Takeout/YouTube and YouTube Music/playlists/My list.csv":      "Playlist ID,Channel ID,Time Created,Time Updated,Title,Description,Visibility\nPL1,UC1,,,My list,A list,private\n\nVideo ID,Time Added\nabc,2026-09-18T12:00:00Z\nabc,2026-09-19T12:00:00Z\n",
		"Takeout/YouTube and YouTube Music/music-library-songs.csv":    "Video ID,Track Title,Artist Name,Album Title\nxyz,Track,Artist,Album\n",
		"Takeout/Mail/private.csv":                                     "not YouTube data",
	}
	parsed := mustParse(t, YouTube{}, writeZip(t, inputs), YouTubeOptions{Account: "owner"})
	if len(parsed.batch.Activity) != 2 || len(parsed.batch.Collections) != 2 || parsed.count(ingest.Dropped) != 1 {
		t.Fatalf("wrong Takeout records: %+v", parsed)
	}
	legacy, err := youtube.ParseHistory([]byte(history), "watch-history.json")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.batch.Activity[0].ExternalID != legacy.Events[0].ExternalID {
		t.Fatal("changed existing history identity")
	}
	var playlist *library.Collection
	for i := range parsed.batch.Collections {
		if parsed.batch.Collections[i].Kind == "playlist" {
			playlist = &parsed.batch.Collections[i]
		}
	}
	if playlist == nil || playlist.ExternalID != "PL1" || playlist.Title != "My list" {
		t.Fatalf("lost native playlist: %+v", playlist)
	}
	entries := playlist.Snapshot.Entries
	if len(entries) != 2 || entries[0].ItemID != entries[1].ItemID || entries[0].Position != 0 || entries[1].Position != 1 || entries[0].ExternalID == entries[1].ExternalID {
		t.Fatalf("lost duplicate membership positions: %+v", entries)
	}
	directPath := fixture(t, t.TempDir(), "renamed.csv", inputs["Takeout/YouTube and YouTube Music/playlists/My list.csv"])
	direct := mustParse(t, YouTube{}, directPath, YouTubeOptions{Account: "owner"})
	if direct.batch.Collections[0].Snapshot.ExternalID != playlist.Snapshot.ExternalID {
		t.Fatal("zip container or filename changed native snapshot identity")
	}
	if playlist.Snapshot.Captured.Value != "" || playlist.Snapshot.Completeness != "unknown" {
		t.Fatal("invented capture date or completeness")
	}
	var track *library.Item
	for i := range parsed.batch.Items {
		if parsed.batch.Items[i].Kind == "track" {
			track = &parsed.batch.Items[i]
		}
	}
	if track == nil || track.Album != "Album" || !reflect.DeepEqual(track.Creators, []string{"Artist"}) {
		t.Fatalf("lost music metadata: %+v", track)
	}
}

func TestYouTubeJSONCollectionExplicitCompleteness(t *testing.T) {
	path := fixture(t, t.TempDir(), "playlist.json", `{"playlistId":"PL2","title":"Saved","completeness":"partial","captured":{"precision":"day","value":"2026-09-19"},"items":[{"videoId":"abc","title":"First","position":7,"timeAdded":"2026-09-18T12:00:00Z"},{"videoId":"abc","title":"First","position":9}]}`)
	snapshot := mustParse(t, YouTube{}, path, YouTubeOptions{}).batch.Collections[0].Snapshot
	if snapshot.Completeness != "partial" || snapshot.Captured.Precision != "day" || len(snapshot.Entries) != 2 || snapshot.Entries[0].Position != 7 || snapshot.Entries[1].Position != 9 {
		t.Fatalf("wrong explicit snapshot: %+v", snapshot)
	}
}

func TestYouTubeCSVImportRetainsEmptySnapshots(t *testing.T) {
	ctx := context.Background()
	target := importtest.Target(t, youtubeKind)
	opts := YouTubeOptions{Account: "owner"}
	importtest.MustImport(t, target, "youtube-media", fixture(t, t.TempDir(), "playlist.csv", "Playlist ID,Title\nPL1,Saved\nVideo ID,Time Added\nabc,\n"), opts)
	importtest.MustImport(t, target, "youtube-media", fixture(t, t.TempDir(), "playlist.csv", "Playlist ID,Title\nPL1,Saved\nVideo ID,Time Added\n"), opts)
	id := library.StableID("collection", library.Identity{Source: "youtube", Account: "owner", ExternalID: "PL1"})
	current, err := target.Store.LibraryCollection(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if current.Snapshot == nil || len(current.Snapshot.Entries) != 0 {
		t.Fatalf("empty export did not become current: %+v", current.Snapshot)
	}
	path := fixture(t, t.TempDir(), "playlist.csv", "Playlist ID,Title\nPL1,Saved\n")
	if mustParse(t, YouTube{}, path, opts).batch.Collections[0].Snapshot != nil {
		t.Fatal("metadata-only export invented an empty snapshot")
	}
	importtest.MustImport(t, target, "youtube-media", path, opts)
	history, err := target.Store.LibraryCollectionSnapshots(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 2 || len(history[0].Entries) != 0 || len(history[1].Entries) != 1 {
		t.Fatalf("snapshot history: %+v", history)
	}
}

func TestYouTubeImportMergesItemMetadataAndEvidence(t *testing.T) {
	exports := filepath.Join(t.TempDir(), "exports")
	fixture(t, exports, "playlists/00.csv", "Video ID,Time Added\nabc,\n")
	fixture(t, exports, "playlists/01.csv", "Video ID,Video Title,Channel Title\nabc,A careful voyage,Named creator\n")
	fixture(t, exports, "playlists/02.csv", "Video ID,Time Added\nabc,\n")
	target := importtest.Target(t, youtubeKind)
	raw := importtest.MustImport(t, target, "youtube-media", exports, YouTubeOptions{Account: "owner"})
	if raw.Report.Library.Items != 1 || raw.Report.Library.Collections != 3 {
		t.Fatalf("counts: %+v", raw.Report)
	}
	id := library.StableID("item", library.Identity{Source: "youtube", Account: "owner", ExternalID: "video:abc"})
	item, err := target.Store.LibraryItem(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if item.Title != "A careful voyage" || !reflect.DeepEqual(item.Creators, []string{"Named creator"}) || len(item.Evidence) != 3 {
		t.Fatalf("lost metadata or evidence: %+v", item)
	}
	for _, evidence := range item.Evidence {
		if evidence.RawInput != raw.ID || !strings.HasPrefix(evidence.Locator, "playlists/") {
			t.Fatalf("evidence does not name its raw input: %+v", evidence)
		}
	}
}

func TestMarkdownPublicationPrivacyAndProvenance(t *testing.T) {
	root := t.TempDir()
	fixture(t, root, "CLAUDE.md", "vault")
	fixture(t, root, "wiki/notes/a.md", "---\ntitle: A title\nanswers: [A hidden question]\nAliases: ignored\naliases: [Alias]\ntags: [tag]\n---\n# A\nBody\n")
	fixture(t, root, "wiki/notes/p.md", "---\nsensitivity: personal\n---\n# Personal\nPrivate body\n")
	fixture(t, root, "wiki/notes/c.md", "---\nsensitivity: confidential\n---\n# Confidential\nSecret\n")
	fixture(t, root, "wiki/health/h.md", "# Health\nHealth body\n")
	fixture(t, root, "wiki/journal/j.md", "# Journal\nPersonal journal\n")
	fixture(t, root, "wiki/hot.md", "# Hot cache with private context")
	fixture(t, root, "wiki/meta/retrieval-qa.md", "# Search fixture questions")
	fixture(t, root, "wiki/meta/rendered.md", "<!-- auto-generated by 'brain render' (catalog) -->\n# Generated\n")
	fixture(t, root, "archive/original.md", "# Do not publish\n")
	fixture(t, root, ".raw/source.md", "# Do not publish\n")
	fixture(t, root, "wiki/.hidden/hidden.md", "# Do not publish\n")
	publication, err := BuildPublication(root, PublicationOptions{Account: "vault"})
	if err != nil {
		t.Fatal(err)
	}
	if len(publication.Pages) != 1 || len(publication.Inputs) != 1 {
		t.Fatalf("published private originals: %+v", publication)
	}
	page := publication.Pages[0]
	if page.Path != "wiki/notes/a.md" || page.Title != "A title" || page.Revision != page.ContentHash || len(page.ContentHash) != 64 || len(page.Answers) != 1 || len(page.Aliases) != 1 {
		t.Fatalf("lost page metadata: %+v", page)
	}
	if page.Provenance != (library.Provenance{Locator: "wiki/notes/a.md"}) {
		t.Fatalf("page provenance: %+v", page.Provenance)
	}
	personal, err := BuildPublication(root, PublicationOptions{Account: "vault", MaxSensitivity: "personal"})
	if err != nil {
		t.Fatal(err)
	}
	if len(personal.Pages) != 3 {
		t.Fatalf("personal publication count: %d", len(personal.Pages))
	}
	found := false
	for _, candidate := range personal.Pages {
		if candidate.Path == page.Path {
			found = candidate.ID == page.ID
		}
	}
	if !found {
		t.Fatal("identity changed with publication policy")
	}
	health, err := BuildPublication(filepath.Join(root, "wiki", "health"), PublicationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(health.Pages) != 0 {
		t.Fatal("subdirectory selection bypassed inherited sensitivity")
	}
}

func TestMarkdownMalformedFrontmatterFailsPublication(t *testing.T) {
	root := t.TempDir()
	fixture(t, root, "a.md", "---\ntitle: [broken\n---\n# Body\n")
	if _, err := BuildPublication(root, PublicationOptions{}); err == nil {
		t.Fatal("silently published incomplete malformed scan")
	}
	meta, body, err := readFrontmatter([]byte("---\n---\n# Empty metadata\n"))
	if err != nil || meta.Title != "" || !strings.HasPrefix(body, "# Empty metadata") {
		t.Fatalf("valid empty frontmatter: %+v %q %v", meta, body, err)
	}
}

func TestBundleRequiresOneObjectWithoutPages(t *testing.T) {
	root := t.TempDir()
	batch := emptyBatch()
	raw, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parse(Bundle{}, fixture(t, root, "library.json", string(raw)+" {}"), BundleOptions{}); err == nil {
		t.Fatal("accepted trailing JSON")
	}
	batch.Pages = []library.Page{{Identity: library.Identity{Source: "markdown", ExternalID: "a.md"}, Path: "a.md", Title: "A", Body: "private source without verified originals", Sensitivity: "normal"}}
	pageBundle, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parse(Bundle{}, fixture(t, root, "pages.json", string(pageBundle)), BundleOptions{}); err == nil {
		t.Fatal("generic bundle bypassed checked Markdown publication")
	}
}

func TestNetflixImportReplays(t *testing.T) {
	ctx := context.Background()
	target := importtest.Target(t, netflixKind)
	root := t.TempDir()
	path := fixture(t, root, "history.csv", "Title,Date\nA Film,9/19/26\nA Film,9/19/26\nBroken,not-a-date\n")
	opts := NetflixOptions{Account: "owner"}
	first := importtest.MustImport(t, target, "netflix", path, opts).Report
	second := importtest.MustImport(t, target, "netflix", path, opts)
	if first.Library.Items != 1 || first.Library.Activity != 2 || second.Report.Library.Items != 0 || second.Report.Library.Activity != 0 || second.Report.Library.Duplicates != 3 || second.Report.Issues[ingest.Skipped] != 1 {
		t.Fatalf("wrong replay counts: %+v %+v", first, second.Report)
	}
	rows, err := target.Store.ListLibraryActivity(ctx, library.ListOptions{Source: "netflix"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].Provenance.RawInput != second.ID {
		t.Fatalf("wrong stored activities: %+v", rows)
	}
	overlapPath := fixture(t, root, "new-history.csv", "Title,Date\nNew Film,9/20/26\nA Film,9/19/26\nA Film,9/19/26\nA Film,9/19/26\n")
	overlap := importtest.MustImport(t, target, "netflix", overlapPath, opts).Report.Library
	if overlap.Items != 1 || overlap.Activity != 2 || overlap.Duplicates != 3 {
		t.Fatalf("overlap lost multiplicity or repeated observations: %+v", overlap)
	}
	rows, err = target.Store.ListLibraryActivity(ctx, library.ListOptions{Source: "netflix"})
	if err != nil || len(rows) != 4 {
		t.Fatalf("wrong recurring export activity: %d %v", len(rows), err)
	}
}

func TestMarkdownPublicationRevokesReclassifiedPages(t *testing.T) {
	target := importtest.Target(t, markdownKind)
	source := filepath.Join(t.TempDir(), "notes")
	path := fixture(t, source, "a.md", "# Previously normal\nOriginal\n")
	opts := PublicationOptions{Account: "selected-notes"}
	publication, err := BuildPublication(source, opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := publish(t, target, publication); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nsensitivity: confidential\n---\n# New secret\nDo not archive or publish\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if publication, err = BuildPublication(source, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := publish(t, target, publication); err != nil {
		t.Fatal(err)
	}
	pages, err := target.Store.ListLibraryPages(context.Background(), library.ListOptions{Source: "markdown", Account: opts.Account})
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 0 {
		t.Fatal("reclassified page remains searchable")
	}
}

func TestPublicationFailureKeepsPriorPagesAndRejectsSecretBytes(t *testing.T) {
	target := importtest.Target(t, markdownKind)
	notes := filepath.Join(t.TempDir(), "notes")
	fixture(t, notes, "a.md", "---\ntitle: Published\n---\n# Published\nOriginal body\n")
	publication, err := BuildPublication(notes, PublicationOptions{Account: "publication-owner"})
	if err != nil {
		t.Fatal(err)
	}
	rawID, err := publish(t, target, publication)
	if err != nil {
		t.Fatal(err)
	}
	publication.Inputs[0].Bytes = []byte("---\nsensitivity: confidential\n---\n# Secret\nNew private body\n")
	if _, err := publish(t, target, publication); err == nil {
		t.Fatal("accepted reclassified secret source with normal page metadata")
	}
	pages, err := target.Store.ListLibraryPages(context.Background(), library.ListOptions{Source: "markdown", Account: publication.Account})
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 || pages[0].Title != "Published" || !strings.Contains(pages[0].Body, "Original body") {
		t.Fatalf("failed publication changed prior pages: %+v", pages)
	}
	if pages[0].Provenance != (library.Provenance{RawInput: rawID, Locator: "a.md"}) {
		t.Fatalf("page provenance: %+v", pages[0].Provenance)
	}
}

func TestInboxRejectsInvalidLibraryRecordsAndContinues(t *testing.T) {
	ctx := context.Background()
	target := importtest.Target(t, bundleKind, netflixKind)
	st := target.Store
	item := library.Item{Identity: library.Identity{Source: "example", ExternalID: "existing"}, Kind: "movie", Title: "Existing"}
	item.ID = library.StableID("item", item.Identity)
	event := library.Activity{Identity: library.Identity{Source: "example", ExternalID: "event"}, ItemID: item.ID, Kind: "watch", Occurred: library.Date{Precision: "day", Value: "2026-10-01"}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{event}}); err != nil {
		t.Fatal(err)
	}
	missing := event
	missing.ExternalID = "missing"
	missing.ItemID = "item:missing"
	mismatch := item
	mismatch.ID = "item:wrong"
	conflict := event
	conflict.Occurred.Value = "2026-10-02"
	good := item
	good.ExternalID = "good"
	good.ID = ""
	nul := good
	nul.ExternalID = "nul"
	nul.Title = "bad\x00title"
	inputs := map[string]library.ImportBatch{
		"a-missing.json":  {Version: 1, Activity: []library.Activity{missing}},
		"b-mismatch.json": {Version: 1, Items: []library.Item{mismatch}},
		"c-conflict.json": {Version: 1, Activity: []library.Activity{conflict}},
		"d-nul.json":      {Version: 1, Items: []library.Item{nul}},
		"e-good.json":     {Version: 1, Items: []library.Item{good}},
	}
	inboxDir := filepath.Join(t.TempDir(), "inbox")
	settled := time.Now().Add(-time.Hour)
	for name, batch := range inputs {
		raw, err := json.Marshal(batch)
		if err != nil {
			t.Fatal(err)
		}
		path := fixture(t, filepath.Join(inboxDir, "library"), name, string(raw))
		if err := os.Chtimes(path, settled, settled); err != nil {
			t.Fatal(err)
		}
	}
	invalidCSV := fixture(t, filepath.Join(inboxDir, "netflix"), "invalid-encoding.csv", "Title,Date\nCaf\xe9 Show,2026-10-01\n")
	if err := os.Chtimes(invalidCSV, settled, settled); err != nil {
		t.Fatal(err)
	}
	route := func(ctx context.Context, kind, path string) (store.RawInput, error) {
		return importtest.Import(t, target, kind, path, nil)
	}
	kinds := target.Kinds.Names()
	result, err := inbox.Sweep(ctx, inboxDir, kinds, route)
	if err != nil || result.Rejected != 5 || result.Imported != 1 || result.Failed != 0 {
		t.Fatalf("invalid input stalled the inbox: %+v %v", result, err)
	}
	second, err := inbox.Sweep(ctx, inboxDir, kinds, route)
	if err != nil || len(second.Files) != 0 {
		t.Fatalf("rejected input retried: %+v %v", second, err)
	}
	rows, err := st.ListLibraryItems(ctx, library.ListOptions{Source: "example"})
	if err != nil || len(rows) != 2 {
		t.Fatalf("valid input was not preserved: %+v %v", rows, err)
	}
}
