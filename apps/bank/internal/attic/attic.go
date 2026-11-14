// Package attic is what bank's server needs from the file catalogue: its
// operations and its answers to combined search, the timeline and refs. The
// catalogue's own packages stay behind it. The server is not the machine the
// disks attach to, so nothing here says whether a disk is attached.
package attic

import (
	"context"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/session"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

// Catalogue is the file catalogue as bank's server sees it.
type Catalogue struct {
	store    *store.Store
	sessions *session.Manager
}

// New serves the catalogue in st, which may be nil when only the OpenAPI
// document is wanted. Scans that write through the API spool large archive
// listings below spool.
func New(st *store.Store, spool string) *Catalogue {
	return &Catalogue{store: st, sessions: session.New(st, spool)}
}

// Register adds the catalogue's operations to api.
func (c *Catalogue) Register(a huma.API) { api.Register(a, c.store, c.sessions) }

// Close ends the scans still writing through the API as interrupted.
func (c *Catalogue) Close() error { return c.sessions.Close() }

// ErrNotFound means no content matches a ref.
var ErrNotFound = store.ErrNotFound

// Content is one unique content and every place it lives or lived.
func (c *Catalogue) Content(ctx context.Context, cited ref.Content) (view.Content, error) {
	detail, err := c.store.Content(ctx, cited)
	if err != nil {
		return view.Content{}, err
	}
	return view.NewContent(detail, nil), nil
}

// Places lists where each content sits on disks now: the entries that hold
// it, present ones first.
func (c *Catalogue) Places(ctx context.Context, digests []content.Digest) (map[content.Digest][]view.Place, error) {
	hits, err := c.store.CurrentPlaces(ctx, digests)
	if err != nil {
		return nil, err
	}
	places := make(map[content.Digest][]view.Place, len(hits))
	for digest, h := range hits {
		places[digest] = view.Places(h, nil)
	}
	return places, nil
}

// ModifiedFiles lists files on disks last modified in [since, until), oldest first.
func (c *Catalogue) ModifiedFiles(ctx context.Context, since, until time.Time, limit int) ([]view.Place, error) {
	hits, err := c.store.Modified(ctx, since, until, limit)
	return view.Places(hits, nil), err
}

// SearchDisks finds files by name, path, archive listing, text, tags and OCR.
func (c *Catalogue) SearchDisks(ctx context.Context, o store.SearchOptions) (view.SearchResult, error) {
	return view.Search(ctx, c.store, o, nil)
}
