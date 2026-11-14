package api

import (
	"errors"
	"log/slog"
	"net/http"
	"reflect"

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
	_, invalidSearch := errors.AsType[*store.InvalidSearchError](err)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return errNotFound.New(err.Error())
	case invalidSearch, errors.Is(err, fail.ErrInvalid):
		return httpapi.Invalid.New(err.Error())
	}
	slog.Error("HTTP request failed", "error", err)
	return httpapi.Internal.New(http.StatusText(http.StatusInternalServerError))
}
