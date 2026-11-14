package api

import (
	"errors"
	"log/slog"
	"net/http"
	"reflect"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/session"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
)

var (
	errNotFound = httpapi.Kind{Tag: httpapi.NotFound.Tag, Status: http.StatusNotFound,
		Doc: "No content, entry, volume or scan matches."}
	AmbiguousRef = httpapi.Kind{Tag: "AmbiguousRef", Status: http.StatusConflict,
		Doc: "The ref prefix matches several contents. Retry with one of the candidates' longer refs.",
		Extra: map[string]reflect.Type{
			"ref":        reflect.TypeFor[string](),
			"candidates": reflect.TypeFor[[]store.RefCandidate](),
		}}
	AmbiguousVolume = httpapi.Kind{Tag: "AmbiguousVolume", Status: http.StatusConflict,
		Doc: "The disk resembles known volumes without matching one. Retry with volume_id if it is one of the candidates, or new_volume if it is another disk.",
		Extra: map[string]reflect.Type{
			"fingerprint": reflect.TypeFor[disk.Fingerprint](),
			"candidates":  reflect.TypeFor[[]store.Volume](),
		}}
	errScanRunning = httpapi.Kind{Tag: "ScanRunning", Status: http.StatusConflict,
		Doc: "Another scan of this volume is open and still sending. A scan that has sent nothing for two keepalive intervals is replaced by a new one instead; any open scan ends when it finishes or has sent nothing for its idle time."}
	errClaimLost = httpapi.Kind{Tag: "ClaimLost", Status: http.StatusConflict,
		Doc: "The lease ran out and another worker holds the work now, or the result was saved already. Nothing changed."}
)

// Ambiguous is the documented failure for an ambiguous content ref.
func Ambiguous(err *store.AmbiguousRefError) *httpapi.Error {
	return AmbiguousRef.New(err.Error()).With("ref", err.Ref).With("candidates", err.Candidates)
}

// failure turns a store error into the documented failure. Anything not
// classified here is the server's, and its cause stays in the log.
func failure(err error) error {
	if ambiguous, ok := errors.AsType[*store.AmbiguousRefError](err); ok {
		return Ambiguous(ambiguous)
	}
	if ambiguous, ok := errors.AsType[*store.AmbiguousVolumeError](err); ok {
		return AmbiguousVolume.New(ambiguous.Error()).With("fingerprint", ambiguous.Fingerprint).With("candidates", ambiguous.Candidates)
	}
	_, invalidSearch := errors.AsType[*store.InvalidSearchError](err)
	switch {
	case errors.Is(err, store.ErrScanRunning):
		return errScanRunning.New(err.Error())
	case errors.Is(err, store.ErrClaimLost):
		return errClaimLost.New(err.Error())
	case errors.Is(err, store.ErrNotFound), errors.Is(err, session.ErrNotOpen):
		return errNotFound.New(err.Error())
	case invalidSearch, errors.Is(err, fail.ErrInvalid):
		return httpapi.Invalid.New(err.Error())
	}
	slog.Error("HTTP request failed", "error", err)
	return httpapi.Internal.New(http.StatusText(http.StatusInternalServerError))
}
