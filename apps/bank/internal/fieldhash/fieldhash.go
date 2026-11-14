// Package fieldhash names a record by the fields that identify it, for records
// whose source gives them no name of their own. The name is a BLAKE3 digest,
// like a content's, but of fields rather than of bytes, so it is a string and
// never a content.Digest.
package fieldhash

import (
	"encoding/binary"
	"encoding/hex"

	"lukechampine.com/blake3"
)

// Hex returns the BLAKE3-256 digest of fields as 64 lowercase hex
// characters. Each field is preceded by its length as 8 big-endian bytes, so
// two different lists of fields never hash the same bytes, whatever the
// fields contain.
func Hex(fields ...string) string {
	h := blake3.New(32, nil)
	var length [8]byte
	for _, f := range fields {
		binary.BigEndian.PutUint64(length[:], uint64(len(f)))
		_, _ = h.Write(length[:])
		_, _ = h.Write([]byte(f))
	}
	return hex.EncodeToString(h.Sum(nil))
}
