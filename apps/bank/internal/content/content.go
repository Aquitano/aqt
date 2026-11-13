// Package content names bytes by their BLAKE3-256 digest, the one identity a
// message attachment, a library file and a file on a disk share.
package content

import (
	"context"
	"database/sql/driver"
	"encoding/hex"
	"fmt"
	"io"
	"sync"

	"lukechampine.com/blake3"
)

// Digest is a content's BLAKE3-256 digest. It travels as 64 lowercase hex
// characters in JSON, paths and URLs, and as 32 bytes in the database.
type Digest [32]byte

// Parse accepts exactly 64 lowercase hex characters, so a digest taken from
// argv or off the wire is refused where it enters.
func Parse(s string) (Digest, error) {
	var d Digest
	if len(s) != 2*len(d) {
		return d, fmt.Errorf("not a BLAKE3 digest: %q has %d characters, not %d", s, len(s), 2*len(d))
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return d, fmt.Errorf("not a BLAKE3 digest: %q is not lowercase hex", s)
		}
	}
	_, err := hex.Decode(d[:], []byte(s))
	return d, err
}

func (d Digest) String() string { return hex.EncodeToString(d[:]) }

func (d Digest) IsZero() bool { return d == Digest{} }

func (d Digest) MarshalText() ([]byte, error) { return hex.AppendEncode(nil, d[:]), nil }

func (d *Digest) UnmarshalText(text []byte) error {
	parsed, err := Parse(string(text))
	if err != nil {
		return err
	}
	*d = parsed
	return nil
}

func (d Digest) Value() (driver.Value, error) { return d[:], nil }

// Scan reads a bytea column. NULL, from an outer join that found no
// content, reads as the zero digest.
func (d *Digest) Scan(src any) error {
	if src == nil {
		*d = Digest{}
		return nil
	}
	b, ok := src.([]byte)
	if !ok || len(b) != len(d) {
		return fmt.Errorf("a BLAKE3 digest is %d bytes, got %T", len(d), src)
	}
	copy(d[:], b)
	return nil
}

// Sum is Hash for bytes already in memory.
func Sum(data []byte) Digest { return blake3.Sum256(data) }

var buffers = sync.Pool{New: func() any { return new([1 << 20]byte) }}

// Hash reads r to its end and returns its digest and length. Cancelling ctx
// stops it within one buffer, so a 50 GB disk image does not hold up Ctrl+C.
// Wrap r in io.TeeReader to hash bytes while writing them somewhere.
func Hash(ctx context.Context, r io.Reader) (Digest, int64, error) {
	var d Digest
	buffer := buffers.Get().(*[1 << 20]byte)
	defer buffers.Put(buffer)
	h := blake3.New(len(d), nil)
	n, err := io.CopyBuffer(h, contextReader{ctx, r}, buffer[:])
	if err != nil {
		return d, n, err
	}
	h.Sum(d[:0])
	return d, n, nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (c contextReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
