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

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
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
	path := fixture(t, root, "history.csv", "Title,Date\nA Film,9/19/26\nA Film,9/19/26\n")
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
	if first.Items != 1 || first.Activity != 2 || second.Items != 0 || second.Activity != 0 {
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
	entries, err := os.ReadDir(filepath.Join(archiveDir, "markdown"))
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
	entries, err := os.ReadDir(filepath.Join(archiveDir, "markdown"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatal("archived unvalidated confidential bytes")
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
