package main

import (
	"context"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// reads are the lookups that span the archive and the file catalogue. A
// remote `bank serve` answers them itself; locally, the store and the
// catalogue in the same database do.
type reads interface {
	Find(ctx context.Context, query string, messages store.SearchOpts, o library.ListOptions) (catalog.Result, error)
	Resolve(ctx context.Context, ref string) (catalog.Resolved, error)
	Timeline(ctx context.Context, since, until time.Time, groups []string, limit int) (catalog.Timeline, error)
	GetMessageDetailByRef(ctx context.Context, ref string) (store.MessageDetail, error)
	GetThreadPage(ctx context.Context, source, threadID string, o store.ThreadOpts) (store.Thread, error)
}

var _ reads = (*client.Client)(nil)

func openReads(ctx context.Context) (reads, func(), error) {
	if c := client.FromEnv(); c != nil {
		return c, func() {}, nil
	}
	st, err := openStore(ctx)
	if err != nil {
		return nil, nil, err
	}
	local := localReads{Store: st}
	// A database without the catalogue answers from the archive alone.
	catalogue, err := attic.Open(ctx, databaseURL())
	if err != nil {
		return local, st.Close, nil
	}
	local.catalogue = catalogue
	return local, func() { catalogue.Close(); st.Close() }, nil
}

type localReads struct {
	*store.Store
	catalogue *attic.Catalogue
}

func (l localReads) Find(ctx context.Context, query string, messages store.SearchOpts, o library.ListOptions) (catalog.Result, error) {
	var disks catalog.Disks
	if l.catalogue != nil {
		disks = l.catalogue
	}
	return catalog.Find(ctx, l.Store, disks, query, messages, o)
}

func (l localReads) Resolve(ctx context.Context, ref string) (catalog.Resolved, error) {
	var contents catalog.Contents
	if l.catalogue != nil {
		contents = l.catalogue
	}
	return catalog.Resolve(ctx, l.Store, contents, ref)
}

func (l localReads) Timeline(ctx context.Context, since, until time.Time, groups []string, limit int) (catalog.Timeline, error) {
	var files catalog.Files
	if l.catalogue != nil {
		files = l.catalogue
	}
	return catalog.BuildTimeline(ctx, l.Store, files, catalog.TimelineOptions{Since: since, Until: until, Groups: groups, Limit: limit})
}
