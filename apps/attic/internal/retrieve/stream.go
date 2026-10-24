package retrieve

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"

	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

// Source is an open copy of a content, ready to stream to a reader that
// cannot be handed a file, such as an HTTP client.
type Source struct {
	Result
	file   *os.File
	digest disk.Digest
}

// Open opens the first present copy on an attached disk that the current
// rules allow, falling back to the next when one cannot be opened.
func Open(ctx context.Context, content store.Retrieval, known []store.Volume, mounted []disk.Volume, cfg config.Config) (*Source, error) {
	sel := selectCopies(content, known, mounted)
	if len(sel.candidates) == 0 {
		return nil, &UnavailableError{Volumes: sel.offline}
	}
	var failures []error
	for _, p := range sel.candidates {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		f, err := openCopy(p, sel.mounts, known, cfg)
		if err != nil {
			failures = append(failures, fmt.Errorf("%s on %q: %w", p.Path, p.Volume, err))
			continue
		}
		return &Source{
			Result: Result{Ref: "attic:" + content.Ref, Blake3: hex.EncodeToString(content.Digest[:]),
				EntryID: p.ID, VolumeID: p.VolumeID, Source: p.Path, Size: content.Size},
			file: f, digest: content.Digest,
		}, nil
	}
	return nil, errors.Join(&UnavailableError{Volumes: sel.offline}, errors.Join(failures...))
}

// heldBack is how much of the end of a file Copy keeps until the whole file
// has hashed to the catalogued digest.
const heldBack = 64 << 10

// Copy streams the source to w and closes it. Bytes already written cannot be
// taken back, so the final block is written only once the whole file matched
// its digest: a reader that received every byte received the right ones, and
// a copy that changed since its scan ends short with scratch.ErrChanged.
func (s *Source) Copy(w io.Writer) error {
	defer s.file.Close()
	h := blake3.New(len(s.digest), nil)
	held := int(min(s.Size, heldBack))
	if _, err := io.CopyN(io.MultiWriter(w, h), s.file, s.Size-int64(held)); err != nil {
		if errors.Is(err, io.EOF) {
			err = scratch.ErrChanged
		}
		return fmt.Errorf("%s: %w", s.Source, err)
	}
	// One byte more than expected tells a file that grew from one that ended.
	tail := make([]byte, held+1)
	n, err := io.ReadFull(s.file, tail)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return fmt.Errorf("%s: %w", s.Source, err)
	}
	_, _ = h.Write(tail[:min(n, held)])
	var got disk.Digest
	h.Sum(got[:0])
	if n != held || got != s.digest {
		return fmt.Errorf("%s: %w", s.Source, scratch.ErrChanged)
	}
	_, err = w.Write(tail[:held])
	return err
}
