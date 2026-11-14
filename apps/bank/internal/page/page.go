// Package page bounds every list and search, over HTTP and on the command
// line alike.
package page

import "github.com/aquitano/aqt/apps/bank/internal/fail"

const (
	// DefaultLimit is the page size when a caller names none.
	DefaultLimit = 100
	// MaxLimit is the largest page: large enough for "everything about X",
	// small enough that a typo cannot ask for the whole archive.
	MaxLimit = 500
	// MaxOffset bounds how deep paging may go. Every offset re-ranks or
	// re-sorts the whole match set before discarding the skipped rows, so
	// past this point narrowing the request beats paging through it.
	MaxOffset = 10000
)

// Check refuses a limit or offset outside the bounds.
func Check(limit, offset int) error {
	if limit < 1 || limit > MaxLimit {
		return fail.Invalidf("limit must be 1-%d", MaxLimit)
	}
	if offset < 0 || offset > MaxOffset {
		return fail.Invalidf("offset must be 0-%d; narrow the request instead of paging deeper", MaxOffset)
	}
	return nil
}

// Limit is limit with 0 standing for DefaultLimit, for callers that leave it
// unset.
func Limit(limit int) int {
	if limit == 0 {
		return DefaultLimit
	}
	return limit
}
