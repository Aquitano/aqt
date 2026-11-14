package session

import (
	"context"

	"github.com/aquitano/aqt/apps/bank/internal/disks/config"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Hashes pages through the files below the scan root whose digest is
// unknown. Each says whether a hard link already holds its digest, so the
// client can take it without asking per file.
func (m *Manager) Hashes(ctx context.Context, id int64, r WorkRequest) (Work[HashWork], error) {
	w := Work[HashWork]{Items: []HashWork{}}
	err := m.use(id, func(s *session) error {
		var err error
		if r.Count {
			if w.Total, w.Bytes, err = s.sc.PendingTotals(ctx); err != nil {
				return err
			}
		}
		if r.Limit == 0 {
			return nil
		}
		page, err := s.sc.NextPending(ctx, store.Pending{ID: r.AfterID, Path: r.AfterPath}, r.Limit)
		if err != nil {
			return err
		}
		reusable, err := s.sc.ReusableLinks(ctx, page)
		if err != nil {
			return err
		}
		for _, p := range page {
			w.Items = append(w.Items, HashWork{Pending: p, Reusable: reusable[p.ID]})
		}
		return nil
	})
	return w, err
}

// Archives pages through the archives whose content has no listing at the
// depth their folder asks for.
func (m *Manager) Archives(ctx context.Context, id int64, r WorkRequest) (Work[store.PendingArchive], error) {
	w := Work[store.PendingArchive]{Items: []store.PendingArchive{}}
	ranges := make([]config.ArchiveRange, len(r.Ranges))
	for i, p := range r.Ranges {
		ranges[i] = config.ArchiveRange(p)
	}
	err := m.use(id, func(s *session) error {
		var err error
		if r.Count {
			if w.Total, err = s.sc.ArchiveTotals(ctx, ranges, r.UnpackMaxBytes); err != nil {
				return err
			}
		}
		if r.Limit == 0 {
			return nil
		}
		page, err := s.sc.NextArchives(ctx, store.PendingArchive{ID: r.AfterID, Path: r.AfterPath}, r.Limit, ranges, r.UnpackMaxBytes)
		w.Items = append(w.Items, page...)
		return err
	})
	return w, err
}

// Texts pages through the documents whose content has no text.
func (m *Manager) Texts(ctx context.Context, id int64, r WorkRequest) (Work[store.PendingText], error) {
	w := Work[store.PendingText]{Items: []store.PendingText{}}
	err := m.use(id, func(s *session) error {
		var err error
		if r.Count {
			if w.Total, err = s.sc.TextTotals(ctx, r.Extensions); err != nil {
				return err
			}
		}
		if r.Limit == 0 {
			return nil
		}
		page, err := s.sc.NextTexts(ctx, store.PendingText{ID: r.AfterID, Path: r.AfterPath}, r.Extensions, r.Limit)
		w.Items = append(w.Items, page...)
		return err
	})
	return w, err
}

// Metadata pages through the files whose content has no embedded metadata.
func (m *Manager) Metadata(ctx context.Context, id int64, r WorkRequest) (Work[MetadataWork], error) {
	w := Work[MetadataWork]{Items: []MetadataWork{}}
	err := m.use(id, func(s *session) error {
		var err error
		if r.Count {
			if w.Total, err = s.sc.MetadataTotals(ctx); err != nil {
				return err
			}
		}
		if r.Limit == 0 {
			return nil
		}
		page, err := s.sc.NextMetadata(ctx, store.ContentFile{ID: r.AfterID, Path: r.AfterPath}, r.Limit)
		for _, f := range page {
			w.Items = append(w.Items, MetadataWork{ID: f.ID, Path: f.Path, ContentID: f.ContentID, Size: f.Size, Stamp: f.Stamp})
		}
		return err
	})
	return w, err
}

// NeedsListing says whether a listing of a content at a depth would be kept
// now. The client asks only for a content it listed already in this scan; for
// the others the page it came from said so.
func (m *Manager) NeedsListing(ctx context.Context, id int64, c ListingCheck) (ListingNeeded, error) {
	var needed ListingNeeded
	err := m.use(id, func(s *session) error {
		l, err := s.sc.StartListing(ctx, c.ContentID, c.Depth, c.UnpackMaxBytes)
		if l != nil {
			l.Abort(ctx)
		}
		needed.Needed = l != nil
		return err
	})
	return needed, err
}

// ArchivePart is how the catalogue saw a multipart archive's sibling volume.
func (m *Manager) ArchivePart(ctx context.Context, id int64, r ArchivePartRequest) (store.Stamp, error) {
	var stamp store.Stamp
	err := m.use(id, func(s *session) error {
		var err error
		stamp, err = s.sc.ArchivePart(ctx, r.Path)
		return err
	})
	return stamp, err
}
