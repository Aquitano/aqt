// Package verify checks that the blob store still holds every content the
// database names: message attachments, library files and raw inputs. Imports
// write a message and its attachments together after their bytes are stored,
// so damage found here comes from the disk, a restore or a hand edit, not from
// an interrupted import. Nothing is repaired: a raw input can be replayed with
// `bank reimport` once its bytes are back.
package verify

import (
	"context"
	"fmt"
	"os"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Kinds of damage, stable strings so JSON consumers can branch on them.
const (
	MissingBlob = "missing_blob" // no bytes in the blob store
	CorruptBlob = "corrupt_blob" // bytes do not hash to the recorded digest
	WrongSize   = "wrong_size"   // bytes hash correctly but size_bytes disagrees
)

type Finding struct {
	Kind   string         `json:"kind"`
	BLAKE3 content.Digest `json:"blake3"`
	Detail string         `json:"detail"`
	// Uses names up to three records that hold the content; Holders counts
	// them all.
	Uses    []string `json:"uses"`
	Holders int64    `json:"holders"`
}

type Report struct {
	ContentsChecked int64     `json:"contents_checked"`
	Damaged         int       `json:"damaged"`
	Findings        []Finding `json:"findings"`
}

// maxFindings bounds the report so a badly damaged archive still returns
// something printable. Damaged keeps counting past it.
const maxFindings = 500

// Run hashes every held content against its digest and size.
func Run(ctx context.Context, st *store.Store, blobs *blob.Store) (Report, error) {
	rep := Report{Findings: []Finding{}}
	err := st.EachHeldContent(ctx, func(held store.HeldContent) error {
		rep.ContentsChecked++
		kind, detail, err := check(ctx, blobs, held)
		if err != nil || kind == "" {
			return err
		}
		rep.Damaged++
		if len(rep.Findings) < maxFindings {
			rep.Findings = append(rep.Findings, Finding{Kind: kind, BLAKE3: held.BLAKE3, Detail: detail, Uses: held.Uses, Holders: held.Holders})
		}
		return nil
	})
	return rep, err
}

func check(ctx context.Context, blobs *blob.Store, held store.HeldContent) (string, string, error) {
	f, err := os.Open(blobs.Path(held.BLAKE3))
	if err != nil {
		return MissingBlob, "no bytes in the blob store", nil
	}
	defer f.Close()
	sum, size, err := content.Hash(ctx, f)
	if err != nil {
		return "", "", err
	}
	if sum != held.BLAKE3 {
		return CorruptBlob, "content hashes to " + sum.String(), nil
	}
	if size != held.SizeBytes {
		return WrongSize, fmt.Sprintf("size_bytes says %d, file is %d", held.SizeBytes, size), nil
	}
	return "", "", nil
}
