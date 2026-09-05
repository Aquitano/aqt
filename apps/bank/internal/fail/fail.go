// Package fail separates malformed input from operational failure. An importer
// may skip and count a record the source got wrong, but a broken database, a
// full disk or a cancelled context must abort the run with its real cause —
// counting those as "malformed messages" hides data loss behind a tally.
package fail

import (
	"context"
	"errors"
	"fmt"
)

type opError struct{ err error }

func (e opError) Error() string { return e.err.Error() }
func (e opError) Unwrap() error { return e.err }

// Op marks err as an operational failure: the database, the archive, the blob
// store or the context, not the input.
func Op(err error) error {
	if err == nil {
		return nil
	}
	return opError{err}
}

// Opf wraps a formatted message the same way, for the common
// fail.Opf("insert message: %w", err) call site.
func Opf(format string, args ...any) error {
	return Op(fmt.Errorf(format, args...))
}

// IsOp reports whether err is operational. Context cancellation always is:
// the input was never reached, so nothing about it can be blamed.
func IsOp(err error) bool {
	if err == nil {
		return false
	}
	var op opError
	return errors.As(err, &op) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded)
}
