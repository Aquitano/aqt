// Package attic is what a host process needs from the file catalogue: its
// HTTP API and its search. The catalogue's own packages stay behind it.
package attic

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
)

// ErrNotReady means the catalogue is still migrating, or its migration
// failed; the host's log says which.
var ErrNotReady = errors.New("the file catalogue is not ready")

// Catalogue is a read-only catalogue that may still be opening.
type Catalogue struct {
	opened chan struct{}
	store  *store.Store
	err    error
}

// Start migrates the catalogue in databaseURL and opens it read-only, in the
// background. A migration can rebuild search indexes for minutes, and the
// host must neither wait for that nor stop when it fails: until the catalogue
// is open, every use answers ErrNotReady.
func Start(ctx context.Context, databaseURL string) *Catalogue {
	c := &Catalogue{opened: make(chan struct{})}
	go func() {
		defer close(c.opened)
		if c.store, c.err = migrateAndOpen(ctx, databaseURL); c.err != nil {
			slog.Error("the file catalogue is unavailable", "error", c.err)
		}
	}()
	return c
}

// Open opens a migrated catalogue read-only.
func Open(ctx context.Context, databaseURL string) (*Catalogue, error) {
	st, err := store.OpenReadOnly(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	c := &Catalogue{opened: make(chan struct{}), store: st}
	close(c.opened)
	return c, nil
}

func migrateAndOpen(ctx context.Context, databaseURL string) (*store.Store, error) {
	migrated, err := store.Open(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	migrated.Close()
	return store.OpenReadOnly(ctx, databaseURL)
}

func (c *Catalogue) ready() (*store.Store, error) {
	select {
	case <-c.opened:
		if c.err != nil {
			return nil, ErrNotReady
		}
		return c.store, nil
	default:
		return nil, ErrNotReady
	}
}

// Close waits for Start to finish, so cancel its context first.
func (c *Catalogue) Close() {
	<-c.opened
	if c.store != nil {
		c.store.Close()
	}
}

// Handler serves the catalogue's API for host, and 503 until it is open.
func (c *Catalogue) Handler(host api.Host) http.Handler {
	serve := sync.OnceValue(func() http.Handler { return api.New(c.store, config.Default(), host) })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := c.ready(); err != nil {
			api.NotReady(w)
			return
		}
		serve().ServeHTTP(w, r)
	})
}

// ModifiedFiles lists files on disks last modified in [since, until), oldest first.
func (c *Catalogue) ModifiedFiles(ctx context.Context, since, until time.Time, limit int) ([]view.Place, error) {
	st, err := c.ready()
	if err != nil {
		return nil, err
	}
	vols, err := st.KnownVolumes(ctx)
	if err != nil {
		return nil, err
	}
	hits, err := st.Modified(ctx, since, until, limit)
	return view.Places(hits, view.OnlineRoots(vols)), err
}

// SearchDisks finds files by name, path, archive listing, text, tags and OCR.
// Every word has to match.
func (c *Catalogue) SearchDisks(ctx context.Context, query string, limit, offset int) (view.SearchResult, error) {
	st, err := c.ready()
	if err != nil {
		return view.SearchResult{}, err
	}
	vols, err := st.KnownVolumes(ctx)
	if err != nil {
		return view.SearchResult{}, err
	}
	return view.Search(ctx, st, store.SearchOptions{Query: query, Limit: limit, Offset: offset}, view.OnlineRoots(vols))
}
