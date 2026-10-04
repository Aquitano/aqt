package mediaimport

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/inbox"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/youtube"
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

func TestNetflixDatesAndExactReplayIdentity(t *testing.T) {
	path := fixture(t, t.TempDir(), "viewing.csv", "Title,Date\nA Film,9/19/26\nA Film,9/19/26\nShow: Season 2: A Day,2026-09-18\nUndated,\nBroken,not-a-date\n")
	opts := Options{Account: "profile-a"}
	first, err := Parse("netflix", path, opts)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Parse("netflix", path, opts)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first.Batch, second.Batch) {
		t.Fatal("same export changed identities")
	}
	if len(first.Batch.Activity) != 4 || first.Skipped != 1 || len(first.Batch.Items) != 3 {
		t.Fatalf("wrong counts: %+v", first)
	}
	if first.Batch.Activity[0].Occurred != (library.Date{Value: "2026-09-19", Precision: "day"}) {
		t.Fatalf("lost day precision: %+v", first.Batch.Activity[0])
	}
	if first.Batch.Activity[0].ID == first.Batch.Activity[1].ID {
		t.Fatal("collapsed duplicate rows")
	}
	if first.Batch.Activity[3].Occurred.Precision != "unknown" {
		t.Fatal("invented an unknown date")
	}
	if first.Batch.Items[1].Kind != "episode" || first.Batch.Items[1].Series != "Show" || *first.Batch.Items[1].Season != 2 {
		t.Fatalf("episode metadata: %+v", first.Batch.Items[1])
	}
	for _, item := range first.Batch.Items {
		if item.State.Status != "" || item.ProviderID != "" {
			t.Fatal("inferred completion or native identity")
		}
	}
	opts.Account = "profile-b"
	other, err := Parse("netflix", path, opts)
	if err != nil {
		t.Fatal(err)
	}
	if other.Batch.Activity[0].ID == first.Batch.Activity[0].ID {
		t.Fatal("merged accounts")
	}
}

func TestNetflixOverlappingExportsPreserveMultiplicity(t *testing.T) {
	root := t.TempDir()
	firstPath := fixture(t, root, "first.csv", "Title,Date\nA Film,9/19/26\nA Film,9/19/26\nOther,9/18/26\n")
	secondPath := fixture(t, root, "second.csv", "Title,Date\nNew,9/20/26\nOther,9/18/26\nA Film,9/19/26\nA Film,9/19/26\nA Film,9/19/26\n")
	first, err := Parse("netflix", firstPath, Options{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Parse("netflix", secondPath, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for i, j := range []int{2, 3, 1} {
		if first.Batch.Activity[i].ID != second.Batch.Activity[j].ID {
			t.Fatalf("overlap changed identity: %+v %+v", first.Batch.Activity[i], second.Batch.Activity[j])
		}
	}
	if second.Batch.Activity[4].ID == second.Batch.Activity[3].ID || second.Batch.Activity[2].Provenance.Locator != "second.csv: CSV row 4" {
		t.Fatal("lost extra occurrence or its exported row")
	}
}

func TestNetflixDateOrder(t *testing.T) {
	path := fixture(t, t.TempDir(), "viewing.csv", "Title,Date\nAmbiguous,3/4/26\nDay first,19/9/2026\nISO,2026-09-18\n")
	parsed, err := Parse("netflix", path, Options{NetflixDateOrder: "dmy"})
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Batch.Activity) != 3 || parsed.Batch.Activity[0].Occurred.Value != "2026-04-03" || parsed.Batch.Activity[1].Occurred.Value != "2026-09-19" {
		t.Fatalf("wrong day-first interpretation: %+v", parsed)
	}
	parsed, err = Parse("netflix", path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Skipped != 1 || parsed.Batch.Activity[0].Occurred.Value != "2026-03-04" {
		t.Fatalf("default date order changed: %+v", parsed)
	}
	if _, err := Parse("netflix", path, Options{NetflixDateOrder: "auto"}); err == nil {
		t.Fatal("accepted unsupported date order")
	}
}

func TestYouTubeMixedPositions(t *testing.T) {
	for _, format := range []struct{ name, body string }{
		{"playlist.csv", "Video ID,Position\nfirst,\nsecond,0\nthird,7\nfourth,\n"},
		{"playlist.json", `{"items":[{"videoId":"first"},{"videoId":"second","position":0},{"videoId":"third","position":7},{"videoId":"fourth"}]}`},
	} {
		t.Run(format.name, func(t *testing.T) {
			path := fixture(t, t.TempDir(), format.name, format.body)
			parsed, err := Parse("youtube-media", path, Options{})
			if err != nil {
				t.Fatal(err)
			}
			for i, expected := range []int{1, 0, 7, 2} {
				if got := parsed.Batch.Collections[0].Snapshot.Entries[i].Position; got != expected {
					t.Fatalf("entry %d position %d, expected %d", i, got, expected)
				}
			}
		})
	}
	for _, body := range []string{`{"items":[{"videoId":"a","position":0},{"videoId":"b","position":0}]}`, `{"items":[{"videoId":"a","position":-1}]}`} {
		path := fixture(t, t.TempDir(), "playlist.json", body)
		if _, err := Parse("youtube-media", path, Options{}); err == nil {
			t.Fatal("accepted invalid exported position")
		}
	}
}

func TestYouTubeRenamedHistoryAndPlaylistMusicClassification(t *testing.T) {
	root := t.TempDir()
	historyPath := fixture(t, root, "renamed.json", `[{"title":"Watched A","titleUrl":"https://www.youtube.com/watch?v=abc","time":"2026-09-18T12:00:00Z"}]`)
	parsed, err := Parse("youtube-media", historyPath, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Batch.Activity) != 1 || len(parsed.Batch.Collections) != 0 {
		t.Fatalf("history became a collection: %+v", parsed.Batch)
	}
	malformedHistory := fixture(t, root, "partial.json", `[{"title":"Unreadable"},{"title":"Watched A","titleUrl":"https://www.youtube.com/watch?v=abc","time":"2026-09-18T12:00:00Z"}]`)
	if _, err := Parse("youtube-media", malformedHistory, Options{}); err == nil {
		t.Fatal("partly unreadable history became a collection")
	}
	for _, format := range []struct{ name, body string }{
		{"Favorite songs.csv", "Video ID,Video Title\nabc,A video\n"},
		{"Favorite songs.json", `{"items":[{"videoId":"abc","title":"A video"}]}`},
	} {
		parsed, err := Parse("youtube-media", fixture(t, root, format.name, format.body), Options{})
		if err != nil {
			t.Fatal(err)
		}
		if parsed.Batch.Items[0].Kind != "video" || parsed.Batch.Collections[0].Kind != "playlist" {
			t.Fatalf("filename inferred music: %+v", parsed.Batch)
		}
	}
	musicPath := fixture(t, root, "renamed-music.csv", "Playlist ID,Title\nPL1,Saved tracks\nTrack ID,Track Title\nabc,A track\n")
	parsed, err = Parse("youtube-media", musicPath, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Batch.Collections[0].Kind != "library" || parsed.Batch.Items[0].Kind != "track" {
		t.Fatalf("explicit track metadata lost: %+v", parsed.Batch)
	}
}

func TestYouTubeInputsShareByteBudget(t *testing.T) {
	root := t.TempDir()
	fixture(t, root, "playlists/a.csv", "1234")
	fixture(t, root, "playlists/b.csv", "5678")
	if _, err := readYouTubeInputsWithin(root, 7); err == nil {
		t.Fatal("directory inputs exceeded aggregate budget")
	}
	if inputs, err := readYouTubeInputsWithin(root, 8); err != nil || len(inputs) != 2 {
		t.Fatalf("exact budget failed: %d %v", len(inputs), err)
	}
	var raw bytes.Buffer
	writer := zip.NewWriter(&raw)
	for _, name := range []string{"playlists/a.csv", "playlists/b.csv"} {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte("1234")); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(t.TempDir(), "takeout.zip")
	if err := os.WriteFile(zipPath, raw.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readYouTubeInputsWithin(zipPath, 7); err == nil {
		t.Fatal("ZIP inputs exceeded aggregate budget")
	}
}

func TestYouTubeTakeoutZIPPreservesHistoryAndCollectionPositions(t *testing.T) {
	history := `[{"title":"Watched First","titleUrl":"https://www.youtube.com/watch?v=abc","time":"2026-09-18T12:00:00Z","subtitles":[{"name":"Creator","url":"https://www.youtube.com/channel/UC1"}]},{"title":"Watched First","titleUrl":"https://youtu.be/abc","time":"2026-09-18T13:00:00Z"}]`
	inputs := map[string]string{
		"Takeout/YouTube and YouTube Music/history/watch-history.json": history,
		"Takeout/YouTube and YouTube Music/history/watch-history.html": "invalid HTML should not win over JSON",
		"Takeout/YouTube and YouTube Music/playlists/My list.csv":      "Playlist ID,Channel ID,Time Created,Time Updated,Title,Description,Visibility\nPL1,UC1,,,My list,A list,private\n\nVideo ID,Time Added\nabc,2026-09-18T12:00:00Z\nabc,2026-09-19T12:00:00Z\n",
		"Takeout/YouTube and YouTube Music/music-library-songs.csv":    "Video ID,Track Title,Artist Name,Album Title\nxyz,Track,Artist,Album\n",
		"Takeout/Mail/private.csv":                                     "not YouTube data",
	}
	path := filepath.Join(t.TempDir(), "takeout.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range inputs {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	parsed, err := Parse("youtube", path, Options{Account: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Batch.Activity) != 2 || len(parsed.Batch.Collections) != 2 || len(parsed.Inputs) != 3 {
		t.Fatalf("wrong Takeout records: %+v", parsed)
	}
	legacy, err := youtube.ParseHistory([]byte(history), "watch-history.json")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Batch.Activity[0].ExternalID != legacy.Events[0].ExternalID {
		t.Fatal("changed existing history identity")
	}
	var playlist *library.Collection
	for i := range parsed.Batch.Collections {
		if parsed.Batch.Collections[i].Kind == "playlist" {
			playlist = &parsed.Batch.Collections[i]
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
	direct, err := Parse("youtube-media", directPath, Options{Account: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if direct.Batch.Collections[0].Snapshot.ExternalID != playlist.Snapshot.ExternalID {
		t.Fatal("ZIP container or filename changed native snapshot identity")
	}
	if playlist.Snapshot.Captured.Value != "" || playlist.Snapshot.Completeness != "unknown" {
		t.Fatal("invented capture date or completeness")
	}
	var track *library.Item
	for i := range parsed.Batch.Items {
		if parsed.Batch.Items[i].Kind == "track" {
			track = &parsed.Batch.Items[i]
		}
	}
	if track == nil || track.Album != "Album" || !reflect.DeepEqual(track.Creators, []string{"Artist"}) {
		t.Fatalf("lost music metadata: %+v", track)
	}
}

func TestYouTubeJSONCollectionExplicitCompleteness(t *testing.T) {
	path := fixture(t, t.TempDir(), "playlist.json", `{"playlistId":"PL2","title":"Saved","completeness":"partial","captured":{"precision":"day","value":"2026-09-19"},"items":[{"videoId":"abc","title":"First","position":7,"timeAdded":"2026-09-18T12:00:00Z"},{"videoId":"abc","title":"First","position":9}]}`)
	parsed, err := Parse("youtube", path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := parsed.Batch.Collections[0].Snapshot
	if snapshot.Completeness != "partial" || snapshot.Captured.Precision != "day" || len(snapshot.Entries) != 2 || snapshot.Entries[0].Position != 7 || snapshot.Entries[1].Position != 9 {
		t.Fatalf("wrong explicit snapshot: %+v", snapshot)
	}
}

func TestYouTubeCSVImportRetainsEmptySnapshots(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	archiveDir := filepath.Join(root, "archive")
	opts := Options{Account: "owner"}
	path := fixture(t, root, "playlist.csv", "Playlist ID,Title\nPL1,Saved\nVideo ID,Time Added\nabc,\n")
	if _, err := Import(ctx, st, nil, archiveDir, "youtube-media", path, opts); err != nil {
		t.Fatal(err)
	}
	path = fixture(t, root, "playlist.csv", "Playlist ID,Title\nPL1,Saved\nVideo ID,Time Added\n")
	if _, err := Import(ctx, st, nil, archiveDir, "youtube-media", path, opts); err != nil {
		t.Fatal(err)
	}
	id := library.StableID("collection", library.Identity{Source: "youtube", Account: "owner", ExternalID: "PL1"})
	current, err := st.LibraryCollection(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if current.Snapshot == nil || len(current.Snapshot.Entries) != 0 {
		t.Fatalf("empty export did not become current: %+v", current.Snapshot)
	}
	path = fixture(t, root, "playlist.csv", "Playlist ID,Title\nPL1,Saved\n")
	parsed, err := Parse("youtube-media", path, opts)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Batch.Collections[0].Snapshot != nil {
		t.Fatal("metadata-only export invented an empty snapshot")
	}
	if _, err = Import(ctx, st, nil, archiveDir, "youtube-media", path, opts); err != nil {
		t.Fatal(err)
	}
	history, err := st.LibraryCollectionSnapshots(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 2 || len(history[0].Entries) != 0 || len(history[1].Entries) != 1 {
		t.Fatalf("snapshot history: %+v", history)
	}
}

func TestYouTubeImportMergesItemMetadataAndEvidence(t *testing.T) {
	root := t.TempDir()
	exports := filepath.Join(root, "exports")
	fixture(t, exports, "playlists/00.csv", "Video ID,Time Added\nabc,\n")
	fixture(t, exports, "playlists/01.csv", "Video ID,Video Title,Channel Title\nabc,A careful voyage,Named creator\n")
	fixture(t, exports, "playlists/02.csv", "Video ID,Time Added\nabc,\n")
	ctx := context.Background()
	st := storetest.New(t)
	archiveDir := filepath.Join(root, "archive")
	result, err := Import(ctx, st, nil, archiveDir, "youtube-media", exports, Options{Account: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Items != 1 || result.Collections != 3 {
		t.Fatalf("counts: %+v", result)
	}
	id := library.StableID("item", library.Identity{Source: "youtube", Account: "owner", ExternalID: "video:abc"})
	item, err := st.LibraryItem(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if item.Title != "A careful voyage" || !reflect.DeepEqual(item.Creators, []string{"Named creator"}) || len(item.Evidence) != 3 {
		t.Fatalf("lost metadata or evidence: %+v", item)
	}
	for _, evidence := range item.Evidence {
		if strings.HasPrefix(evidence.RawRef, "input:") {
			t.Fatalf("unresolved evidence: %+v", evidence)
		}
		if _, err := os.ReadFile(filepath.Join(archiveDir, evidence.RawRef)); err != nil {
			t.Fatal(err)
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
	parsed, err := Parse("markdown", root, Options{Account: "vault"})
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Batch.Pages) != 1 || len(parsed.Inputs) != 1 {
		t.Fatalf("published private originals: %+v", parsed)
	}
	page := parsed.Batch.Pages[0]
	if page.Path != "wiki/notes/a.md" || page.Title != "A title" || page.Revision != page.ContentHash || len(page.ContentHash) != 64 || len(page.Answers) != 1 || len(page.Aliases) != 1 {
		t.Fatalf("lost page metadata: %+v", page)
	}
	personal, err := Parse("markdown", root, Options{Account: "vault", MaxSensitivity: "personal"})
	if err != nil {
		t.Fatal(err)
	}
	if len(personal.Batch.Pages) != 3 {
		t.Fatalf("personal publication count: %d", len(personal.Batch.Pages))
	}
	found := false
	for _, candidate := range personal.Batch.Pages {
		if candidate.Path == page.Path {
			found = candidate.ID == page.ID
		}
	}
	if !found {
		t.Fatal("identity changed with publication policy")
	}
	health, err := Parse("markdown", filepath.Join(root, "wiki", "health"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(health.Batch.Pages) != 0 {
		t.Fatal("subdirectory selection bypassed inherited sensitivity")
	}
}

func TestMarkdownMalformedFrontmatterFailsPublication(t *testing.T) {
	root := t.TempDir()
	fixture(t, root, "a.md", "---\ntitle: [broken\n---\n# Body\n")
	if _, err := Parse("markdown", root, Options{}); err == nil {
		t.Fatal("silently published incomplete malformed scan")
	}
	meta, body, err := readFrontmatter([]byte("---\n---\n# Empty metadata\n"))
	if err != nil || meta.Title != "" || !strings.HasPrefix(body, "# Empty metadata") {
		t.Fatalf("valid empty frontmatter: %+v %q %v", meta, body, err)
	}
}

func TestBundleRequiresOneObjectAndPreservedFileBytes(t *testing.T) {
	root := t.TempDir()
	batch := emptyBatch()
	raw, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	path := fixture(t, root, "library.json", string(raw)+" {}")
	if _, err := Parse("library", path, Options{}); err == nil {
		t.Fatal("accepted trailing JSON")
	}
	batch.Pages = []library.Page{{Identity: library.Identity{Source: "markdown", ExternalID: "a.md"}, Path: "a.md", Title: "A", Body: "private source without verified originals", Sensitivity: "normal"}}
	pageBundle, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	path = fixture(t, root, "pages.json", string(pageBundle))
	if _, err := Parse("library", path, Options{}); err == nil {
		t.Fatal("generic bundle bypassed checked Markdown publication")
	}
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	sum, size, err := blobs.Put(bytes.NewBufferString("file bytes"))
	if err != nil {
		t.Fatal(err)
	}
	files := []library.File{{SHA256: sum, SizeBytes: size, Filename: "sample.txt"}}
	if err := verifyBundleFiles(blobs, files); err != nil {
		t.Fatal(err)
	}
	files[0].SizeBytes++
	if err := verifyBundleFiles(blobs, files); err == nil {
		t.Fatal("accepted mismatched file bytes")
	}
	files[0].SHA256 = strings.Repeat("0", 64)
	if err := verifyBundleFiles(blobs, files); err == nil {
		t.Fatal("accepted missing blob")
	}
}

func TestNetflixImportPreservesRawAndReplays(t *testing.T) {
	st := storetest.New(t)
	root := t.TempDir()
	path := fixture(t, root, "history.csv", "Title,Date\nA Film,9/19/26\nA Film,9/19/26\nBroken,not-a-date\n")
	archiveDir := filepath.Join(root, "archive")
	ctx := context.Background()
	first, err := Import(ctx, st, nil, archiveDir, "netflix", path, Options{Account: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Import(ctx, st, nil, archiveDir, "netflix", path, Options{Account: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Items != 1 || first.Activity != 2 || second.Items != 0 || second.Activity != 0 || second.Duplicates != 3 || second.Skipped != 1 {
		t.Fatalf("wrong replay counts: %+v %+v", first, second)
	}
	rows, err := st.ListLibraryActivity(ctx, library.ListOptions{Source: "netflix"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("wrong stored activities: %d", len(rows))
	}
	raw, err := os.ReadFile(filepath.Join(archiveDir, rows[0].Provenance.RawRef))
	if err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, original) {
		t.Fatal("raw source changed")
	}
	overlapPath := fixture(t, root, "new-history.csv", "Title,Date\nNew Film,9/20/26\nA Film,9/19/26\nA Film,9/19/26\nA Film,9/19/26\n")
	overlap, err := Import(ctx, st, nil, archiveDir, "netflix", overlapPath, Options{Account: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	if overlap.Items != 1 || overlap.Activity != 2 || overlap.Duplicates != 3 {
		t.Fatalf("overlap lost multiplicity or repeated observations: %+v", overlap)
	}
	rows, err = st.ListLibraryActivity(ctx, library.ListOptions{Source: "netflix"})
	if err != nil || len(rows) != 4 {
		t.Fatalf("wrong recurring export activity: %d %v", len(rows), err)
	}
}

func TestLibraryRawInputsStayOutsideLegacyYouTubeReplay(t *testing.T) {
	st := storetest.New(t)
	root := t.TempDir()
	archiveDir := filepath.Join(root, "archive")
	ctx := context.Background()
	history := fixture(t, root, "watch-history.json", `[{"title":"Watched Legacy video","titleUrl":"https://www.youtube.com/watch?v=legacy","time":"2026-10-02T12:00:00Z"}]`)
	if result, err := youtube.Import(ctx, st, archiveDir, history); err != nil || result.Inserted != 1 {
		t.Fatalf("legacy history import: %+v %v", result, err)
	}
	playlist := fixture(t, root, "playlist.csv", "Video ID,Video Title\nnew-video,Playlist video\n")
	if _, err := Import(ctx, st, nil, archiveDir, "youtube-media", playlist, Options{Account: "owner"}); err != nil {
		t.Fatal(err)
	}
	notes := filepath.Join(root, "notes")
	fixture(t, notes, "page.md", "# Selected page\nPublished body\n")
	publication, err := BuildPublication(notes, Options{Source: "youtube", Account: "wiki"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Publish(ctx, st, archiveDir, publication); err != nil {
		t.Fatal(err)
	}
	collections, err := st.ListLibraryCollections(ctx, library.ListOptions{Source: "youtube", Account: "owner"})
	if err != nil || len(collections) != 1 || collections[0].Snapshot == nil {
		t.Fatalf("imported collection: %+v %v", collections, err)
	}
	pages, err := st.ListLibraryPages(ctx, library.ListOptions{Source: "youtube", Account: "wiki"})
	if err != nil || len(pages) != 1 {
		t.Fatalf("published page: %+v %v", pages, err)
	}
	for _, ref := range []string{collections[0].Snapshot.Provenance.RawRef, pages[0].Provenance.RawRef} {
		if !strings.HasPrefix(ref, "library/youtube/") || strings.Contains(ref, "\\") {
			t.Fatalf("library input has an incompatible archive reference: %s", ref)
		}
		if _, err := os.ReadFile(filepath.Join(archiveDir, filepath.FromSlash(ref))); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := archive.List(archiveDir, "youtube")
	if err != nil || len(entries) != 1 || entries[0].Name != "watch-history.json" {
		t.Fatalf("library inputs entered legacy replay: %+v %v", entries, err)
	}
	staged, err := archive.Stage(archiveDir, entries[0], t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if result, err := youtube.Import(ctx, st, archiveDir, staged); err != nil || result.Inserted != 0 || result.Duplicates != 1 {
		t.Fatalf("legacy history replay: %+v %v", result, err)
	}
}

func TestMarkdownPublicationRevokesReclassifiedPages(t *testing.T) {
	st := storetest.New(t)
	root := t.TempDir()
	source := filepath.Join(root, "notes")
	path := fixture(t, source, "a.md", "# Previously normal\nOriginal\n")
	archiveDir := filepath.Join(root, "archive")
	ctx := context.Background()
	opts := Options{Account: "selected-notes"}
	if _, err := Import(ctx, st, nil, archiveDir, "markdown", source, opts); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nsensitivity: confidential\n---\n# New secret\nDo not archive or publish\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Import(ctx, st, nil, archiveDir, "markdown", source, opts); err != nil {
		t.Fatal(err)
	}
	pages, err := st.ListLibraryPages(ctx, library.ListOptions{Source: "markdown", Account: opts.Account})
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 0 {
		t.Fatal("reclassified page remains searchable")
	}
	entries, err := os.ReadDir(filepath.Join(archiveDir, "library", "markdown"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatal("archived excluded confidential bytes")
	}
}

func TestPublicationFailureKeepsPriorPagesAndRejectsSecretBytes(t *testing.T) {
	st := storetest.New(t)
	root := t.TempDir()
	notes := filepath.Join(root, "notes")
	fixture(t, notes, "a.md", "---\ntitle: Published\n---\n# Published\nOriginal body\n")
	publication, err := BuildPublication(notes, Options{Account: "publication-owner"})
	if err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "archive")
	ctx := context.Background()
	if _, err := Publish(ctx, st, archiveDir, publication); err != nil {
		t.Fatal(err)
	}
	publication.Inputs[0].Bytes = []byte("---\nsensitivity: confidential\n---\n# Secret\nNew private body\n")
	if _, err := Publish(ctx, st, archiveDir, publication); err == nil {
		t.Fatal("accepted reclassified secret source with normal page metadata")
	}
	pages, err := st.ListLibraryPages(ctx, library.ListOptions{Source: "markdown", Account: publication.Account})
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 || pages[0].Title != "Published" || !strings.Contains(pages[0].Body, "Original body") {
		t.Fatalf("failed publication changed prior pages: %+v", pages)
	}
	entries, err := os.ReadDir(filepath.Join(archiveDir, "library", "markdown"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatal("archived unvalidated confidential bytes")
	}
}

func TestInboxRejectsInvalidLibraryRecordsAndContinues(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	item := library.Item{Identity: library.Identity{Source: "example", ExternalID: "existing"}, Kind: "movie", Title: "Existing"}
	item.ID = library.StableID("item", item.Identity)
	event := library.Activity{Identity: library.Identity{Source: "example", ExternalID: "event"}, ItemID: item.ID, Kind: "watch", Occurred: library.Date{Precision: "day", Value: "2026-10-01"}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{event}}); err != nil {
		t.Fatal(err)
	}
	missing := event
	missing.ExternalID = "missing"
	missing.ItemID = "item_missing"
	mismatch := item
	mismatch.ID = "item_wrong"
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
	inboxDir := filepath.Join(root, "inbox")
	for name, batch := range inputs {
		raw, err := json.Marshal(batch)
		if err != nil {
			t.Fatal(err)
		}
		path := fixture(t, filepath.Join(inboxDir, "library"), name, string(raw))
		settled := time.Now().Add(-time.Hour)
		if err := os.Chtimes(path, settled, settled); err != nil {
			t.Fatal(err)
		}
	}
	invalidCSV := fixture(t, filepath.Join(inboxDir, "netflix"), "invalid-encoding.csv", "Title,Date\nCaf\xe9 Show,2026-10-01\n")
	settled := time.Now().Add(-time.Hour)
	if err := os.Chtimes(invalidCSV, settled, settled); err != nil {
		t.Fatal(err)
	}
	route := func(ctx context.Context, kind, path string) (inbox.Outcome, error) {
		result, err := Import(ctx, st, nil, filepath.Join(root, "archive"), kind, path, Options{})
		return inbox.Outcome{Inserted: result.Items + result.Activity, Duplicates: result.Duplicates}, err
	}
	result, err := inbox.Sweep(ctx, inboxDir, route)
	if err != nil || result.Rejected != 5 || result.Imported != 1 || result.Failed != 0 {
		t.Fatalf("invalid input stalled the inbox: %+v %v", result, err)
	}
	second, err := inbox.Sweep(ctx, inboxDir, route)
	if err != nil || len(second.Files) != 0 {
		t.Fatalf("rejected input retried: %+v %v", second, err)
	}
	rows, err := st.ListLibraryItems(ctx, library.ListOptions{Source: "example"})
	if err != nil || len(rows) != 2 {
		t.Fatalf("valid input was not preserved: %+v %v", rows, err)
	}
}

func TestArchiveFailureIsOperationalAndCreatesNoActivity(t *testing.T) {
	st := storetest.New(t)
	root := t.TempDir()
	path := fixture(t, root, "history.csv", "Title,Date\nA Film,9/19/26\n")
	blocked := fixture(t, root, "blocked", "not a directory")
	_, err := Import(context.Background(), st, nil, blocked, "netflix", path, Options{})
	if err == nil || !fail.IsOp(err) {
		t.Fatalf("archive failure classified as malformed input: %v", err)
	}
	rows, err := st.ListLibraryActivity(context.Background(), library.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatal("persisted activity before preserving original")
	}
}
