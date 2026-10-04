package mediaimport

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/youtube"
)

const maxYouTubeFile = 512 << 20

func youtubeDataFile(name string) bool {
	lower := strings.ToLower(filepath.ToSlash(name))
	base := filepath.Base(lower)
	if strings.HasSuffix(base, "watch-history.json") || strings.HasSuffix(base, "watch-history.html") {
		return true
	}
	ext := filepath.Ext(lower)
	return (ext == ".csv" || ext == ".json") && (strings.Contains(lower, "playlist") || strings.Contains(lower, "library") || strings.Contains(lower, "songs"))
}

func readYouTubeInputs(inputPath string) ([]RawInput, error) {
	return readYouTubeInputsWithin(inputPath, maxYouTubeFile)
}

func readYouTubeInputsWithin(inputPath string, budget int64) ([]RawInput, error) {
	info, err := os.Stat(inputPath)
	if err != nil {
		return nil, err
	}
	inputs := []RawInput{}
	read := func(name string, r io.Reader) error {
		limit := min(int64(maxYouTubeFile), budget)
		raw, err := io.ReadAll(io.LimitReader(r, limit+1))
		if err != nil {
			return err
		}
		if len(raw) > maxYouTubeFile {
			return fmt.Errorf("YouTube input %s exceeds 512 MiB", name)
		}
		if int64(len(raw)) > budget {
			return fmt.Errorf("selected YouTube inputs exceed the total byte limit at %s", name)
		}
		budget -= int64(len(raw))
		inputs = append(inputs, RawInput{Name: filepath.ToSlash(name), Bytes: raw})
		return nil
	}
	switch {
	case info.IsDir():
		err = filepath.WalkDir(inputPath, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.Type()&os.ModeSymlink != 0 {
				return nil
			}
			if d.IsDir() {
				if path != inputPath && strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			rel, err := filepath.Rel(inputPath, path)
			if err != nil {
				return err
			}
			if !youtubeDataFile(rel) {
				return nil
			}
			input, err := os.Open(path)
			if err != nil {
				return err
			}
			defer input.Close()
			return read(rel, input)
		})
	case strings.EqualFold(filepath.Ext(inputPath), ".zip"):
		zr, e := zip.OpenReader(inputPath)
		if e != nil {
			return nil, e
		}
		defer zr.Close()
		for _, entry := range zr.File {
			if entry.FileInfo().IsDir() || !youtubeDataFile(entry.Name) {
				continue
			}
			if !fs.ValidPath(entry.Name) {
				return nil, fmt.Errorf("invalid Takeout member path %q", entry.Name)
			}
			if entry.UncompressedSize64 > maxYouTubeFile {
				return nil, fmt.Errorf("YouTube input %s exceeds 512 MiB", entry.Name)
			}
			if entry.UncompressedSize64 > uint64(budget) {
				return nil, fmt.Errorf("selected YouTube inputs exceed the total byte limit at %s", entry.Name)
			}
			input, e := entry.Open()
			if e != nil {
				return nil, e
			}
			e = read(entry.Name, input)
			closeErr := input.Close()
			if e != nil {
				return nil, e
			}
			if closeErr != nil {
				return nil, closeErr
			}
		}
	default:
		input, e := os.Open(inputPath)
		if e != nil {
			return nil, e
		}
		defer input.Close()
		err = read(filepath.Base(inputPath), input)
	}
	if err != nil {
		return nil, err
	}
	sort.Slice(inputs, func(i, j int) bool { return inputs[i].Name < inputs[j].Name })
	if len(inputs) == 0 {
		return nil, fmt.Errorf("no YouTube watch history, playlist or music library files found")
	}
	return inputs, nil
}

func parseYouTube(inputPath string, opts Options) (Parsed, error) {
	inputs, err := readYouTubeInputs(inputPath)
	if err != nil {
		return Parsed{}, err
	}
	p := Parsed{Batch: emptyBatch(), Inputs: []RawInput{}, Diagnostics: []string{}}
	seen := map[string]int{}
	addItem := func(item library.Item) {
		index, exists := seen[item.ID]
		if !exists {
			seen[item.ID] = len(p.Batch.Items)
			p.Batch.Items = append(p.Batch.Items, item)
			return
		}
		existing := &p.Batch.Items[index]
		if item.Title != item.ProviderID || existing.Title == existing.ProviderID {
			existing.Title = item.Title
		}
		if item.URL != "" {
			existing.URL = item.URL
		}
		if len(item.Creators) > 0 {
			existing.Creators = item.Creators
		}
		if item.Album != "" {
			existing.Album = item.Album
		}
		existing.Evidence = append(existing.Evidence, existing.Provenance)
		existing.Provenance = item.Provenance
	}
	jsonHistory := false
	for _, input := range inputs {
		if youtubeHistoryJSON(input) {
			jsonHistory = true
		}
	}
	for _, input := range inputs {
		lower := strings.ToLower(input.Name)
		if youtubeHistoryJSON(input) || strings.HasSuffix(lower, "watch-history.html") {
			if jsonHistory && strings.HasSuffix(lower, "watch-history.html") {
				continue
			}
			history, err := youtube.ParseHistory(input.Bytes, input.Name)
			if err != nil {
				return p, fmt.Errorf("%s: %w", input.Name, err)
			}
			p.Ads += history.Ads
			p.Skipped += history.Skipped
			if history.Skipped > 0 {
				p.Diagnostics = append(p.Diagnostics, fmt.Sprintf("%s: %d unreadable history records skipped", input.Name, history.Skipped))
			}
			for i, event := range history.Events {
				native := event.VideoID
				external := "video:" + native
				if native == "" {
					external = "unavailable-title:" + digest([]byte(event.Title))
				}
				id := identity(opts, external)
				itemID := library.StableID("item", id)
				prov := provenance(input.Name, fmt.Sprintf("history record %d", i+1))
				item := library.Item{Identity: id, ID: itemID, Kind: "video", Title: event.Title, URL: event.URL, Creators: []string{}, FileIDs: []string{}, Provenance: prov}
				if native != "" {
					item.Provider = "youtube"
					item.ProviderID = native
				}
				if event.Channel != "" {
					item.Creators = []string{event.Channel}
				}
				addItem(item)
				activityIdentity := identity(opts, event.ExternalID)
				p.Batch.Activity = append(p.Batch.Activity, library.Activity{Identity: activityIdentity, ID: library.StableID("activity", activityIdentity), ItemID: itemID, Kind: "watch", Title: event.Title, Occurred: library.Date{Value: event.WatchedAt.Format(time.RFC3339Nano), Precision: "instant"}, Provenance: prov})
			}
			p.Inputs = append(p.Inputs, input)
			continue
		}
		var collections []library.Collection
		var items []library.Item
		var diagnostics []string
		switch strings.ToLower(filepath.Ext(input.Name)) {
		case ".csv":
			items, collections, diagnostics, err = parseYouTubeCSV(input, opts)
		case ".json":
			items, collections, diagnostics, err = parseYouTubeCollectionJSON(input, opts)
		default:
			continue
		}
		if err != nil {
			return p, fmt.Errorf("%s: %w", input.Name, err)
		}
		if len(collections) == 0 {
			p.Skipped++
			p.Diagnostics = append(p.Diagnostics, "No supported collection columns in "+input.Name)
			continue
		}
		for _, item := range items {
			addItem(item)
		}
		p.Batch.Collections = append(p.Batch.Collections, collections...)
		p.Diagnostics = append(p.Diagnostics, diagnostics...)
		p.Inputs = append(p.Inputs, input)
	}
	if len(p.Batch.Activity)+len(p.Batch.Collections) == 0 {
		return p, fmt.Errorf("no usable YouTube history or collections found")
	}
	return p, nil
}

func youtubeHistoryJSON(input RawInput) bool {
	if !strings.EqualFold(filepath.Ext(input.Name), ".json") {
		return false
	}
	if strings.HasSuffix(strings.ToLower(input.Name), "watch-history.json") {
		return true
	}
	decoder := json.NewDecoder(bytes.NewReader(input.Bytes))
	if token, err := decoder.Token(); err != nil || token != json.Delim('[') || !decoder.More() {
		return false
	}
	var first struct {
		Time     json.RawMessage `json:"time"`
		TitleURL json.RawMessage `json:"titleUrl"`
		Header   json.RawMessage `json:"header"`
	}
	if err := decoder.Decode(&first); err != nil {
		return false
	}
	return len(first.Time) > 0 && (len(first.TitleURL) > 0 || len(first.Header) > 0)
}

func youtubeMusicFile(name string) bool {
	base := strings.ToLower(filepath.Base(name))
	return base == "music-library-songs.csv" || base == "music-library-songs.json"
}

func allocateMissingPositions(entries []library.Entry) error {
	used := map[int]bool{}
	for _, entry := range entries {
		if entry.Position == -1 {
			continue
		}
		if entry.Position < 0 || used[entry.Position] {
			return fmt.Errorf("collection entries require unique nonnegative exported positions")
		}
		used[entry.Position] = true
	}
	next := 0
	for i := range entries {
		if entries[i].Position != -1 {
			continue
		}
		for used[next] {
			next++
		}
		entries[i].Position = next
		used[next] = true
	}
	return nil
}

func youtubeVideoID(value string) string {
	u, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if value := u.Query().Get("v"); value != "" {
		return value
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	if host == "youtu.be" && len(parts) == 1 {
		return parts[0]
	}
	if (host == "youtube.com" || host == "music.youtube.com") && len(parts) == 2 && (parts[0] == "shorts" || parts[0] == "live" || parts[0] == "embed") {
		return parts[1]
	}
	return ""
}

func collectionFor(input RawInput, sum string, opts Options, native, title, description string, music bool) library.Collection {
	kind := "playlist"
	external := native
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(input.Name), filepath.Ext(input.Name))
	}
	if music {
		kind = "library"
		if external == "" {
			external = "music-library"
		}
	} else if external == "" {
		external = "playlist-file:" + title
	}
	id := identity(opts, external)
	return library.Collection{Identity: id, ID: library.StableID("collection", id), Kind: kind, Title: title, Description: description, Snapshot: &library.Snapshot{ExternalID: digest([]byte(external + "\x00" + sum)), Captured: opts.CapturedAt, Completeness: "unknown", Provenance: provenance(input.Name, "collection export"), Entries: []library.Entry{}}}
}

func youtubeCollectionItem(input RawInput, sum string, opts Options, row int, native, title, urlValue, creator, album string, music bool) library.Item {
	kind := "video"
	if music {
		kind = "track"
	}
	external := kind + ":" + native
	if native == "" {
		external = "file:" + sum + ":row:" + strconv.Itoa(row)
	}
	if title == "" {
		if native != "" {
			title = native
		} else {
			title = "Untitled exported entry"
		}
	}
	id := identity(opts, external)
	item := library.Item{Identity: id, ID: library.StableID("item", id), Kind: kind, Title: title, URL: urlValue, Album: album, Creators: []string{}, FileIDs: []string{}, Provenance: provenance(input.Name, fmt.Sprintf("collection row %d", row))}
	if native != "" {
		item.Provider = "youtube"
		item.ProviderID = native
		if item.URL == "" {
			item.URL = "https://www.youtube.com/watch?v=" + url.QueryEscape(native)
		}
	}
	if creator != "" {
		item.Creators = []string{creator}
	}
	return item
}

func parseYouTubeCSV(input RawInput, opts Options) ([]library.Item, []library.Collection, []string, error) {
	r := csv.NewReader(bytes.NewReader(input.Bytes))
	r.FieldsPerRecord = -1
	items := []library.Item{}
	collections := []library.Collection{}
	diagnostics := []string{}
	fields := map[string]int{}
	active := -1
	collectionIndex := map[string]int{}
	entrySections := map[int]bool{}
	music := youtubeMusicFile(input.Name)
	sum := digest(input.Bytes)
	title := ""
	native := ""
	description := ""
	ensure := func(id, name, desc string) int {
		key := id
		if key == "" {
			key = name
		}
		if key == "" {
			key = filepath.Base(input.Name)
		}
		if index, ok := collectionIndex[key]; ok {
			return index
		}
		collectionIndex[key] = len(collections)
		collections = append(collections, collectionFor(input, sum, opts, id, name, desc, music))
		return len(collections) - 1
	}
	for row := 1; ; row++ {
		values, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, nil, fmt.Errorf("CSV row %d: %w", row, err)
		}
		nonempty := false
		for _, v := range values {
			if strings.TrimSpace(v) != "" {
				nonempty = true
				break
			}
		}
		if !nonempty {
			continue
		}
		candidate := csvFields(values)
		isHeader := false
		entryHeader := false
		for _, key := range []string{"videoid", "trackid", "songid", "playlistid", "tracktitle", "songtitle"} {
			if _, ok := candidate[key]; ok {
				isHeader = true
				entryHeader = entryHeader || key != "playlistid"
			}
		}
		if isHeader {
			fields = candidate
			for _, field := range []string{"trackid", "songid", "tracktitle", "songtitle"} {
				if _, present := fields[field]; present {
					music = true
				}
			}
			if music {
				for i := range collections {
					collections[i].Kind = "library"
				}
			}
			if entryHeader {
				if _, perRowPlaylist := fields["playlistid"]; !perRowPlaylist && active < 0 {
					active = ensure(native, title, description)
				}
				if active >= 0 {
					entrySections[active] = true
				}
			}
			continue
		}
		if len(fields) == 0 {
			continue
		}
		video := csvValue(values, fields, "videoid", "trackid", "songid")
		urlValue := csvValue(values, fields, "videourl", "songurl", "trackurl", "url")
		if video == "" {
			video = youtubeVideoID(urlValue)
		}
		entryTitle := csvValue(values, fields, "videotitle", "tracktitle", "songtitle")
		if video == "" && entryTitle == "" {
			if value := csvValue(values, fields, "playlistid"); value != "" {
				native = value
				title = csvValue(values, fields, "playlisttitle", "playlistname", "title", "name")
				description = csvValue(values, fields, "description")
				active = ensure(native, title, description)
			}
			continue
		}
		if entryTitle == "" {
			entryTitle = csvValue(values, fields, "title", "name")
		}
		rowPlaylist := csvValue(values, fields, "playlistid")
		if rowPlaylist != "" {
			active = ensure(rowPlaylist, csvValue(values, fields, "playlisttitle", "playlistname"), description)
		}
		if active < 0 {
			active = ensure(native, title, description)
		}
		item := youtubeCollectionItem(input, sum, opts, row, video, entryTitle, urlValue, csvValue(values, fields, "artistname", "artist", "channelname", "channeltitle"), csvValue(values, fields, "albumtitle", "album"), music)
		items = append(items, item)
		addedValue := csvValue(values, fields, "timeadded", "dateadded", "playlistvideocreationtimestamp", "addedat", "timestamp")
		added, err := exportDate(addedValue)
		if err != nil {
			added = library.Date{Precision: "unknown"}
			diagnostics = append(diagnostics, fmt.Sprintf("row %d kept with unknown addition date: %s", row, addedValue))
		}
		snapshot := collections[active].Snapshot
		entryID := csvValue(values, fields, "playlistitemid", "entryid")
		if entryID == "" {
			entryID = "file:" + sum + ":row:" + strconv.Itoa(row)
		}
		position := -1
		if exportedPosition := csvValue(values, fields, "position", "playlistposition"); exportedPosition != "" {
			position, err = strconv.Atoi(exportedPosition)
			if err != nil || position < 0 {
				return nil, nil, nil, fmt.Errorf("row %d has an invalid playlist position", row)
			}
		}
		snapshot.Entries = append(snapshot.Entries, library.Entry{ItemID: item.ID, Position: position, ExternalID: entryID, Added: added})
	}
	for i := range collections {
		if err := allocateMissingPositions(collections[i].Snapshot.Entries); err != nil {
			return nil, nil, nil, err
		}
		if len(collections[i].Snapshot.Entries) == 0 && !entrySections[i] {
			collections[i].Snapshot = nil
		}
	}
	return items, collections, diagnostics, nil
}

type youtubeEntryJSON struct {
	VideoID  string          `json:"videoId"`
	TrackID  string          `json:"trackId"`
	ID       string          `json:"id"`
	Title    string          `json:"title"`
	URL      string          `json:"url"`
	TitleURL string          `json:"titleUrl"`
	Artist   string          `json:"artist"`
	Album    string          `json:"album"`
	Added    string          `json:"timeAdded"`
	AddedAt  string          `json:"addedAt"`
	EntryID  string          `json:"entryId"`
	Position *int            `json:"position"`
	Time     json.RawMessage `json:"time"`
}
type youtubeCollectionJSON struct {
	Kind         string             `json:"kind"`
	PlaylistID   string             `json:"playlistId"`
	ID           string             `json:"id"`
	Title        string             `json:"title"`
	Description  string             `json:"description"`
	Items        []youtubeEntryJSON `json:"items"`
	Entries      []youtubeEntryJSON `json:"entries"`
	Completeness string             `json:"completeness"`
	Captured     library.Date       `json:"captured"`
}

func parseYouTubeCollectionJSON(input RawInput, opts Options) ([]library.Item, []library.Collection, []string, error) {
	var payload youtubeCollectionJSON
	trimmed := bytes.TrimSpace(input.Bytes)
	if len(trimmed) == 0 {
		return nil, nil, nil, fmt.Errorf("empty collection JSON")
	}
	if trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &payload.Items); err != nil {
			return nil, nil, nil, err
		}
	} else if err := json.Unmarshal(trimmed, &payload); err != nil {
		return nil, nil, nil, err
	}
	if payload.PlaylistID == "" {
		payload.PlaylistID = payload.ID
	}
	entries := payload.Items
	if entries == nil {
		entries = payload.Entries
	}
	if entries == nil {
		return []library.Item{}, []library.Collection{}, []string{}, nil
	}
	music := youtubeMusicFile(input.Name) || payload.Kind == "library"
	for _, entry := range entries {
		music = music || entry.TrackID != ""
	}
	sum := digest(input.Bytes)
	collection := collectionFor(input, sum, opts, payload.PlaylistID, payload.Title, payload.Description, music)
	if payload.Completeness != "" {
		collection.Snapshot.Completeness = payload.Completeness
	}
	if payload.Captured.Precision != "" || payload.Captured.Value != "" {
		collection.Snapshot.Captured = payload.Captured
	}
	items := []library.Item{}
	diagnostics := []string{}
	for i, entry := range entries {
		if len(entry.Time) > 0 {
			return nil, nil, nil, fmt.Errorf("entry %d contains watch-history time; import it as YouTube watch history", i+1)
		}
		native := entry.VideoID
		if native == "" {
			native = entry.TrackID
		}
		if native == "" {
			native = entry.ID
		}
		u := entry.URL
		if u == "" {
			u = entry.TitleURL
		}
		if native == "" {
			native = youtubeVideoID(u)
		}
		if native == "" && entry.Title == "" {
			return nil, nil, nil, fmt.Errorf("collection entry %d has neither identity nor title", i+1)
		}
		item := youtubeCollectionItem(input, sum, opts, i+1, native, entry.Title, u, entry.Artist, entry.Album, music)
		items = append(items, item)
		addedValue := entry.Added
		if addedValue == "" {
			addedValue = entry.AddedAt
		}
		added, err := exportDate(addedValue)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("entry %d: %w", i+1, err)
		}
		external := entry.EntryID
		if external == "" {
			external = "file:" + sum + ":row:" + strconv.Itoa(i+1)
		}
		position := -1
		if entry.Position != nil {
			position = *entry.Position
			if position < 0 {
				return nil, nil, nil, fmt.Errorf("entry %d has an invalid playlist position", i+1)
			}
		}
		collection.Snapshot.Entries = append(collection.Snapshot.Entries, library.Entry{ItemID: item.ID, Position: position, ExternalID: external, Added: added})
	}
	if err := allocateMissingPositions(collection.Snapshot.Entries); err != nil {
		return nil, nil, nil, err
	}
	return items, []library.Collection{collection}, diagnostics, nil
}
