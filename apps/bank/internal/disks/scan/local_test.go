package scan

import (
	"context"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Local writes the catalogue in st from this process.
func Local(st *store.Store) Catalogue { return local{st} }

type local struct{ *store.Store }

func (l local) StartScan(ctx context.Context, v store.Volume, root string) (Session, error) {
	sc, err := l.Store.StartScan(ctx, v, root)
	if err != nil {
		return nil, err
	}
	return localScan{sc}, nil
}

type localScan struct{ *store.Scan }

func (s localScan) ID() int64                { return s.Scan.ID }
func (s localScan) Counts() store.ScanCounts { return s.Scan.Counts }

func (s localScan) Finish(ctx context.Context, status string, phases store.PhaseTimes, failure error) (int64, error) {
	s.Phases = phases
	err := s.Scan.Finish(ctx, status, failure)
	files, _, _ := s.PendingTotals(context.WithoutCancel(ctx))
	return files, err
}

func (s localScan) StartListing(ctx context.Context, contentID int64, depth int, unpackMaxBytes int64) (Listing, error) {
	l, err := s.Scan.StartListing(ctx, contentID, depth, unpackMaxBytes)
	if l == nil {
		return nil, err
	}
	return l, err
}
