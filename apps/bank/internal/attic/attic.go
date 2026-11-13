// Package attic is what a host process needs from the file catalogue: its
// HTTP API and its search. The catalogue's own packages stay behind it.
package attic

import (
	"context"
	"net/http"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/content"
)

// Catalogue is the file catalogue as its host process sees it.
type Catalogue struct {
	store *store.Store
}

func New(st *store.Store) *Catalogue { return &Catalogue{store: st} }

// Handler serves the catalogue's API for host.
func (c *Catalogue) Handler(host api.Host) http.Handler {
	return api.New(c.store, config.Default(), host)
}

// ErrNotFound means no content matches a ref.
var ErrNotFound = store.ErrNotFound

// Content is one unique content and every place it lives or lived. ref is a
// content ref, with or without attic:, or a whole BLAKE3 digest in hex.
func (c *Catalogue) Content(ctx context.Context, ref string) (view.Content, error) {
	ref, ok := store.ParseRef(ref)
	if !ok {
		return view.Content{}, ErrNotFound
	}
	vols, err := c.store.KnownVolumes(ctx)
	if err != nil {
		return view.Content{}, err
	}
	detail, err := c.store.Content(ctx, ref)
	if err != nil {
		return view.Content{}, err
	}
	return view.NewContent(detail, view.OnlineRoots(vols)), nil
}

// Places lists where each content sits on disks now: the entries that hold
// it, present ones first.
func (c *Catalogue) Places(ctx context.Context, digests []content.Digest) (map[content.Digest][]view.Place, error) {
	vols, err := c.store.KnownVolumes(ctx)
	if err != nil {
		return nil, err
	}
	hits, err := c.store.CurrentPlaces(ctx, digests)
	if err != nil {
		return nil, err
	}
	roots := view.OnlineRoots(vols)
	places := make(map[content.Digest][]view.Place, len(hits))
	for digest, h := range hits {
		places[digest] = view.Places(h, roots)
	}
	return places, nil
}

// ModifiedFiles lists files on disks last modified in [since, until), oldest first.
func (c *Catalogue) ModifiedFiles(ctx context.Context, since, until time.Time, limit int) ([]view.Place, error) {
	vols, err := c.store.KnownVolumes(ctx)
	if err != nil {
		return nil, err
	}
	hits, err := c.store.Modified(ctx, since, until, limit)
	return view.Places(hits, view.OnlineRoots(vols)), err
}

// SearchDisks finds files by name, path, archive listing, text, tags and OCR.
// Every word has to match.
func (c *Catalogue) SearchDisks(ctx context.Context, query string, limit, offset int) (view.SearchResult, error) {
	vols, err := c.store.KnownVolumes(ctx)
	if err != nil {
		return view.SearchResult{}, err
	}
	return view.Search(ctx, c.store, store.SearchOptions{Query: query, Limit: limit, Offset: offset}, view.OnlineRoots(vols))
}
