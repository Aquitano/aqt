package library

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

var ErrConflict = errors.New("library revision conflict")
var ErrReadOnly = errors.New("imported collections cannot be edited; create a personal collection")

type Identity struct {
	Source     string `json:"source"`
	Account    string `json:"account"`
	ExternalID string `json:"external_id"`
}

type Date struct {
	Value     string `json:"value"`
	Precision string `json:"precision"`
}

type Provenance struct {
	RawRef  string `json:"raw_ref"`
	Locator string `json:"locator"`
}

type Item struct {
	Identity
	ID              string       `json:"id"`
	Kind            string       `json:"kind"`
	Title           string       `json:"title"`
	Description     string       `json:"description"`
	URL             string       `json:"url"`
	Provider        string       `json:"provider"`
	ProviderID      string       `json:"provider_id"`
	Creators        []string     `json:"creators"`
	Series          string       `json:"series"`
	Album           string       `json:"album"`
	Year            *int         `json:"year,omitempty"`
	Season          *int         `json:"season,omitempty"`
	Episode         *int         `json:"episode,omitempty"`
	DurationSeconds *int         `json:"duration_seconds,omitempty"`
	Provenance      Provenance   `json:"provenance"`
	Evidence        []Provenance `json:"evidence"`
	State           State        `json:"state"`
	FileIDs         []string     `json:"file_ids"`
}

type Activity struct {
	Identity
	ID              string       `json:"id"`
	ItemID          string       `json:"item_id"`
	Kind            string       `json:"kind"`
	Title           string       `json:"title"`
	Occurred        Date         `json:"occurred"`
	DurationSeconds *int         `json:"duration_seconds,omitempty"`
	Provenance      Provenance   `json:"provenance"`
	Evidence        []Provenance `json:"evidence"`
}

type Entry struct {
	ItemID     string `json:"item_id"`
	Position   int    `json:"position"`
	ExternalID string `json:"external_id"`
	Added      Date   `json:"added"`
}

type Snapshot struct {
	ID           int64      `json:"id,omitempty"`
	ExternalID   string     `json:"external_id"`
	Captured     Date       `json:"captured"`
	Completeness string     `json:"completeness"`
	Provenance   Provenance `json:"provenance"`
	Entries      []Entry    `json:"entries"`
}

type SnapshotSummary struct {
	ID           int64      `json:"id"`
	ExternalID   string     `json:"external_id"`
	Captured     Date       `json:"captured"`
	Completeness string     `json:"completeness"`
	Provenance   Provenance `json:"provenance"`
	EntryCount   int        `json:"entry_count"`
}

type CollectionSummary struct {
	Identity
	ID          string           `json:"id"`
	Kind        string           `json:"kind"`
	Title       string           `json:"title"`
	Description string           `json:"description"`
	Personal    bool             `json:"personal"`
	Revision    int64            `json:"revision"`
	Snapshot    *SnapshotSummary `json:"snapshot,omitempty"`
}

type ItemSummary struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`
	Source string `json:"source"`
}

type ItemSummaryRequest struct {
	IDs []string `json:"ids"`
}

func (r ItemSummaryRequest) Validate() error {
	if len(r.IDs) > 50 {
		return fmt.Errorf("at most 50 item IDs are allowed")
	}
	for _, id := range r.IDs {
		if id == "" || len(id) > 4096 || strings.ContainsRune(id, 0) {
			return fmt.Errorf("invalid item ID")
		}
	}
	return nil
}

type Collection struct {
	Identity
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Personal    bool      `json:"personal"`
	Revision    int64     `json:"revision"`
	Snapshot    *Snapshot `json:"snapshot,omitempty"`
}

type State struct {
	Revision     int64    `json:"revision"`
	Status       string   `json:"status"`
	Favorite     bool     `json:"favorite"`
	Progress     int      `json:"progress"`
	ProgressUnit string   `json:"progress_unit"`
	Rating       *int     `json:"rating,omitempty"`
	Notes        string   `json:"notes"`
	Tags         []string `json:"tags"`
}

type StateEdit struct {
	ExpectedRevision int64    `json:"expected_revision"`
	Status           string   `json:"status"`
	Favorite         bool     `json:"favorite"`
	Progress         int      `json:"progress"`
	ProgressUnit     string   `json:"progress_unit"`
	Rating           *int     `json:"rating,omitempty"`
	Notes            string   `json:"notes"`
	Tags             []string `json:"tags"`
}

type CollectionEdit struct {
	ExpectedRevision int64   `json:"expected_revision"`
	Title            string  `json:"title"`
	Description      string  `json:"description"`
	Entries          []Entry `json:"entries"`
}

type File struct {
	Identity
	ID         string     `json:"id"`
	SHA256     string     `json:"sha256"`
	Filename   string     `json:"filename"`
	MimeType   string     `json:"mime_type"`
	SizeBytes  int64      `json:"size_bytes"`
	ItemIDs    []string   `json:"item_ids"`
	Provenance Provenance `json:"provenance"`
	TextStatus string     `json:"text_status"`
}

type Page struct {
	Identity
	ID          string     `json:"id"`
	Path        string     `json:"path"`
	Title       string     `json:"title"`
	Body        string     `json:"body"`
	Answers     []string   `json:"answers"`
	Tags        []string   `json:"tags"`
	Aliases     []string   `json:"aliases"`
	ContentHash string     `json:"content_hash"`
	Revision    string     `json:"revision"`
	Sensitivity string     `json:"sensitivity"`
	Provenance  Provenance `json:"provenance"`
}

type ImportBatch struct {
	Version     int          `json:"version"`
	Items       []Item       `json:"items"`
	Activity    []Activity   `json:"activity"`
	Collections []Collection `json:"collections"`
	Files       []File       `json:"files"`
	Pages       []Page       `json:"pages"`
}

type ImportResult struct {
	Duplicates  int `json:"duplicates"`
	Items       int `json:"items"`
	Activity    int `json:"activity"`
	Collections int `json:"collections"`
	Files       int `json:"files"`
	Pages       int `json:"pages"`
}

type ListOptions struct {
	Match   string
	Query   string
	Source  string
	Account string
	Kind    string
	ItemID  string
	Limit   int
	Offset  int
	Since   string
	Until   string
}

type SearchResult struct {
	Items       []Item              `json:"items"`
	Activity    []Activity          `json:"activity"`
	Collections []CollectionSummary `json:"collections"`
	Files       []File              `json:"files"`
	Pages       []Page              `json:"pages"`
	Coverage    []string            `json:"coverage"`
}

func StableID(kind string, identity Identity) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + identity.Source + "\x00" + identity.Account + "\x00" + identity.ExternalID))
	return kind + "_" + hex.EncodeToString(sum[:16])
}

func (d Date) Validate() error {
	switch d.Precision {
	case "", "unknown":
		if d.Value != "" {
			return fmt.Errorf("unknown date must have an empty value")
		}
	case "day":
		if _, err := time.Parse("2006-01-02", d.Value); err != nil {
			return fmt.Errorf("invalid day: %w", err)
		}
	case "instant":
		if _, err := time.Parse(time.RFC3339Nano, d.Value); err != nil {
			return fmt.Errorf("invalid instant: %w", err)
		}
	default:
		return fmt.Errorf("date precision must be unknown, day or instant")
	}
	return nil
}

func (o ListOptions) Validate() error {
	if !in(o.Match, "", "any", "all", "phrase") {
		return fmt.Errorf("match must be any, all or phrase")
	}
	if !in(o.Kind, "", "message", "item", "activity", "collection", "file", "page", "video", "movie", "series", "episode", "track", "album", "podcast", "book", "article", "other", "watch", "listen", "read", "play", "view", "purchase", "playlist", "library", "watchlist", "list") {
		return fmt.Errorf("unsupported kind %q", o.Kind)
	}
	if o.Limit < 0 || o.Limit > 500 || o.Offset < 0 || o.Offset > 100000 {
		return fmt.Errorf("limit must be 0-500 and offset 0-100000")
	}
	for _, v := range []string{o.Since, o.Until} {
		if v != "" {
			if _, err := time.Parse("2006-01-02", v); err != nil {
				if _, err = time.Parse(time.RFC3339Nano, v); err != nil {
					return fmt.Errorf("date filters require YYYY-MM-DD or RFC3339")
				}
			}
		}
	}
	if len(o.Query) > 4096 {
		return fmt.Errorf("query exceeds 4096 bytes")
	}
	return nil
}

func validIdentity(v Identity) error {
	if strings.TrimSpace(v.Source) == "" || strings.TrimSpace(v.ExternalID) == "" {
		return fmt.Errorf("source and external_id are required")
	}
	for _, s := range []string{v.Source, v.Account, v.ExternalID} {
		if len(s) > 4096 || strings.ContainsRune(s, 0) {
			return fmt.Errorf("invalid identity")
		}
	}
	return nil
}

func in(v string, choices ...string) bool {
	for _, choice := range choices {
		if v == choice {
			return true
		}
	}
	return false
}

func validateEntries(entries []Entry) error {
	positions := map[int]bool{}
	if len(entries) > 100000 {
		return fmt.Errorf("too many collection entries")
	}
	for _, entry := range entries {
		if entry.ItemID == "" || entry.Position < 0 || positions[entry.Position] {
			return fmt.Errorf("collection entries require item_id and unique nonnegative positions")
		}
		positions[entry.Position] = true
		if err := entry.Added.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func (e StateEdit) Validate() error {
	if e.ExpectedRevision < 0 || !in(e.Status, "", "planned", "in_progress", "completed", "dropped", "seen", "paused") {
		return fmt.Errorf("invalid state revision or status")
	}
	if e.Progress < 0 || !in(e.ProgressUnit, "", "episodes", "pages", "seconds", "percent") || (e.Progress > 0 && e.ProgressUnit == "") || (e.ProgressUnit == "percent" && e.Progress > 100) {
		return fmt.Errorf("invalid progress or progress_unit")
	}
	if e.Rating != nil && (*e.Rating < 1 || *e.Rating > 5) {
		return fmt.Errorf("rating must be 1-5")
	}
	if len(e.Notes) > 1<<20 || len(e.Tags) > 1000 {
		return fmt.Errorf("state exceeds size bounds")
	}
	return nil
}

func (e CollectionEdit) Validate() error {
	if e.ExpectedRevision < 0 || strings.TrimSpace(e.Title) == "" {
		return fmt.Errorf("title and nonnegative expected_revision required")
	}
	return validateEntries(e.Entries)
}

func (b ImportBatch) Validate() error {
	if b.Version != 1 {
		return fmt.Errorf("library bundle version must be 1")
	}
	if len(b.Items)+len(b.Activity)+len(b.Collections)+len(b.Files)+len(b.Pages) > 100000 {
		return fmt.Errorf("library batch exceeds 100000 records")
	}
	for _, v := range b.Items {
		if err := v.Provenance.Validate(); err != nil {
			return err
		}
		for _, evidence := range v.Evidence {
			if err := evidence.Validate(); err != nil {
				return err
			}
		}
		if v.State.Revision != 0 || v.State.Status != "" || v.State.Favorite || v.State.Rating != nil || v.State.Notes != "" || len(v.State.Tags) > 0 || v.State.Progress != 0 || v.State.ProgressUnit != "" {
			return fmt.Errorf("personal state must be changed through an explicit revision-checked state edit")
		}
		if err := validIdentity(v.Identity); err != nil {
			return err
		}
		if !in(v.Kind, "video", "movie", "series", "episode", "track", "album", "podcast", "book", "article", "other") || strings.TrimSpace(v.Title) == "" {
			return fmt.Errorf("item requires supported kind and title")
		}
		if (v.Provider == "") != (v.ProviderID == "") {
			return fmt.Errorf("provider and provider_id must be supplied together")
		}
		if v.Year != nil && (*v.Year < 1 || *v.Year > 9999) {
			return fmt.Errorf("year must be 1-9999")
		}
		for _, n := range []*int{v.Season, v.Episode, v.DurationSeconds} {
			if n != nil && *n < 0 {
				return fmt.Errorf("item numbers cannot be negative")
			}
		}
	}
	for _, v := range b.Activity {
		if err := v.Provenance.Validate(); err != nil {
			return err
		}
		for _, evidence := range v.Evidence {
			if err := evidence.Validate(); err != nil {
				return err
			}
		}
		if err := validIdentity(v.Identity); err != nil {
			return err
		}
		if v.ItemID == "" || !in(v.Kind, "watch", "listen", "read", "play", "view", "purchase", "other") {
			return fmt.Errorf("activity requires item_id and supported kind")
		}
		if err := v.Occurred.Validate(); err != nil {
			return err
		}
		if v.DurationSeconds != nil && *v.DurationSeconds < 0 {
			return fmt.Errorf("duration cannot be negative")
		}
	}
	for _, v := range b.Collections {
		if err := validIdentity(v.Identity); err != nil {
			return err
		}
		if strings.TrimSpace(v.Title) == "" || !in(v.Kind, "playlist", "library", "watchlist", "list") {
			return fmt.Errorf("collection requires title and supported kind")
		}
		if v.Personal {
			return fmt.Errorf("import cannot write personal collections")
		}
		if v.Snapshot != nil {
			if err := v.Snapshot.Provenance.Validate(); err != nil {
				return err
			}
			if v.Snapshot.ExternalID == "" || !in(v.Snapshot.Completeness, "complete", "partial", "unknown") {
				return fmt.Errorf("snapshot requires external_id and completeness")
			}
			if err := v.Snapshot.Captured.Validate(); err != nil {
				return err
			}
			if err := validateEntries(v.Snapshot.Entries); err != nil {
				return err
			}
		}
	}
	for _, v := range b.Files {
		if err := v.Provenance.Validate(); err != nil {
			return err
		}
		if err := validIdentity(v.Identity); err != nil {
			return err
		}
		if len(v.SHA256) != 64 || strings.TrimLeft(v.SHA256, "0123456789abcdef") != "" || v.SizeBytes < 0 || v.Filename == "" {
			return fmt.Errorf("file requires SHA256, filename and nonnegative size")
		}
	}
	for _, v := range b.Pages {
		if err := v.Provenance.Validate(); err != nil {
			return err
		}
		if err := validIdentity(v.Identity); err != nil {
			return err
		}
		if v.Path == "" || v.Title == "" || len(v.Body) > 8<<20 {
			return fmt.Errorf("page requires path, title and body under 8 MiB")
		}
	}
	return nil
}

func (p Provenance) Validate() error {
	if p.RawRef == "" {
		return nil
	}
	reference := strings.ReplaceAll(p.RawRef, "\\", "/")
	reference = strings.TrimPrefix(reference, "input:")
	if !filepath.IsLocal(reference) || reference == "" || strings.HasPrefix(reference, "/") || strings.ContainsAny(reference, ":\x00") {
		return fmt.Errorf("raw_ref must be a relative archive reference")
	}
	for _, part := range strings.Split(reference, "/") {
		if part == ".." {
			return fmt.Errorf("raw_ref cannot contain parent traversal")
		}
	}
	return nil
}
