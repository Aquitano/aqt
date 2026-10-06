package blobtext

import (
	"fmt"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
)

// ValidStatus keeps a typo in --status from silently selecting nothing. The
// pending pseudo-status counts: it is what a caller names to mean content no
// extraction has touched, and leaving it out of the message would make a valid
// choice look wrong.
func ValidStatus(s string) error {
	if s == store.StatusPending || ValidStoredStatus(s) == nil {
		return nil
	}
	return unknownStatus(s, append([]string{store.StatusPending}, statusNames()...))
}

// ValidStoredStatus is the same check for a status about to be written to a
// row, which is a stricter question than which content to select: pending
// means "no row at all", so storing it would leave content that no default
// pass ever looks at again. The HTTP write route takes its status from a query
// string, and that is the one place a caller can invent one.
func ValidStoredStatus(s string) error {
	for _, k := range extract.Statuses {
		if extract.Status(s) == k {
			return nil
		}
	}
	return unknownStatus(s, statusNames())
}

// ValidRunStatus is the same check for content an automatic pass may work on.
// Manual text is a transcription someone made by hand or with better tools
// than this binary has; re-running extraction over it would replace it with
// whatever tesseract makes of the same page, and nothing could rebuild it.
func ValidRunStatus(s string) error {
	if s == string(extract.StatusManual) {
		return fmt.Errorf("--status manual would overwrite transcriptions made by hand: " +
			"replace one with `bank attachment text <sha256> --set`, " +
			"or clear it with `--clear` to put the content back in the queue")
	}
	return ValidStatus(s)
}

func statusNames() []string {
	names := make([]string, 0, len(extract.Statuses))
	for _, k := range extract.Statuses {
		names = append(names, string(k))
	}
	return names
}

func unknownStatus(s string, names []string) error {
	return fmt.Errorf("unknown status %q (want one of: %s)", s, strings.Join(names, ", "))
}
