// Package inbox sweeps the drop zone: exports copied into
// $BANK_DATA_DIR/inbox/<kind>/ are routed to the importer that owns that
// directory and then filed away by outcome.
//
// Nothing moves before an importer has returned, and every importer is
// idempotent, so an interrupted sweep is safe to re-run: whatever is still in
// the drop zone has either not been imported or was imported and will
// deduplicate on the second pass.
package inbox

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aquitano/aqt-bank/internal/fail"
)

// Kinds are the importer names that double as inbox subdirectory names.
var Kinds = []string{"whatsapp", "eml", "mbox", "discord", "linkedin", "chatgpt", "claude", "claude-code", "json"}

// Outcome is what a router reports back about one imported file, reduced to
// the three numbers the sweep needs to pick a disposition.
type Outcome struct {
	Inserted   int
	Duplicates int
	Rejected   int
	// Result is the importer's own result value, carried through to JSON
	// output untouched.
	Result any
}

// Router imports one path with the importer that owns kind.
type Router func(ctx context.Context, kind, path string) (Outcome, error)

// Disposition is what the sweep did with a file. Each one is retry-safe:
// anything not filed away stays in the drop zone for the next run.
type Disposition string

const (
	// Imported: the file added messages and moved to inbox/.done/<kind>/.
	Imported Disposition = "imported"
	// Duplicate: every message was already archived; the file still moves to
	// .done, because re-importing it would keep producing this same answer.
	Duplicate Disposition = "duplicate"
	// Rejected: the importer could not read the file. It moves to
	// inbox/.rejected/<kind>/ so the next sweep does not trip over it again.
	Rejected Disposition = "rejected"
	// Failed: the database, archive or blob store failed. The file stays
	// exactly where it is, because nothing about it was wrong.
	Failed Disposition = "failed"
)

type FileResult struct {
	Path        string      `json:"path"`
	Kind        string      `json:"kind"`
	Disposition Disposition `json:"disposition"`
	MovedTo     string      `json:"moved_to,omitempty"`
	Detail      string      `json:"detail,omitempty"`
	Result      any         `json:"result,omitempty"`
}

type Result struct {
	Files      []FileResult `json:"files"`
	Imported   int          `json:"imported"`
	Duplicates int          `json:"duplicates"`
	Rejected   int          `json:"rejected"`
	Failed     int          `json:"failed"`
}

const (
	doneDir     = ".done"
	rejectedDir = ".rejected"
)

// Sweep processes every entry dropped under inboxDir. It stops at the first
// operational failure — a broken database will only produce a longer list of
// the same error — and returns what it managed before that.
func Sweep(ctx context.Context, inboxDir string, route Router) (Result, error) {
	res := Result{Files: []FileResult{}}
	for _, kind := range Kinds {
		entries, err := os.ReadDir(filepath.Join(inboxDir, kind))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return res, err
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if !strings.HasPrefix(e.Name(), ".") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names) // a deterministic order makes a re-run comparable
		for _, name := range names {
			path := filepath.Join(inboxDir, kind, name)
			fr, err := sweepOne(ctx, inboxDir, kind, path, route)
			res.Files = append(res.Files, fr)
			switch fr.Disposition {
			case Imported:
				res.Imported++
			case Duplicate:
				res.Duplicates++
			case Rejected:
				res.Rejected++
			case Failed:
				res.Failed++
			}
			if err != nil {
				return res, err
			}
		}
	}
	return res, nil
}

func sweepOne(ctx context.Context, inboxDir, kind, path string, route Router) (FileResult, error) {
	fr := FileResult{Path: path, Kind: kind}
	out, err := route(ctx, kind, path)
	switch {
	case err != nil && fail.IsOp(err):
		fr.Disposition = Failed
		fr.Detail = err.Error()
		return fr, err
	case err != nil:
		fr.Disposition = Rejected
		fr.Detail = err.Error()
		moved, moveErr := file(inboxDir, rejectedDir, kind, path)
		fr.MovedTo = moved
		return fr, moveErr
	}
	fr.Result = out.Result
	if out.Rejected > 0 {
		fr.Detail = fmt.Sprintf("%d record(s) rejected", out.Rejected)
	}
	bucket := doneDir
	switch {
	case out.Inserted > 0:
		fr.Disposition = Imported
	case out.Duplicates > 0:
		fr.Disposition = Duplicate
	case out.Rejected > 0:
		// The importer read the file but kept none of it; calling that
		// "imported" would file a problem away as a success.
		fr.Disposition = Rejected
		bucket = rejectedDir
	default:
		fr.Disposition = Imported // read fine, had nothing to add
	}
	moved, moveErr := file(inboxDir, bucket, kind, path)
	fr.MovedTo = moved
	return fr, moveErr
}

// file moves a processed entry out of the drop zone, never overwriting an
// earlier one of the same name.
func file(inboxDir, bucket, kind, path string) (string, error) {
	dir := filepath.Join(inboxDir, bucket, kind)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fail.Opf("create %s: %w", dir, err)
	}
	base := filepath.Base(path)
	dest := filepath.Join(dir, base)
	for n := 2; ; n++ {
		if _, err := os.Lstat(dest); os.IsNotExist(err) {
			break
		}
		ext := filepath.Ext(base)
		dest = filepath.Join(dir, fmt.Sprintf("%s-%d%s", strings.TrimSuffix(base, ext), n, ext))
	}
	if err := os.Rename(path, dest); err != nil {
		return "", fail.Opf("move %s: %w", path, err)
	}
	return dest, nil
}
