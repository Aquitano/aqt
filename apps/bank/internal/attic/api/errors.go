package api

import (
	"errors"
	"log/slog"
	"net/http"
	"reflect"

	"github.com/aquitano/aqt/apps/bank/internal/attic/retrieve"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
)

var (
	errNotFound = httpapi.Kind{Tag: httpapi.NotFound.Tag, Status: http.StatusNotFound,
		Doc: "No content, entry, volume or scan matches."}
	AmbiguousRef = httpapi.Kind{Tag: "AmbiguousRef", Status: http.StatusConflict,
		Doc:   "The ref prefix matches several contents. Retry with one of the candidates' longer refs.",
		Extra: map[string]reflect.Type{"candidates": reflect.TypeFor[[]store.RefCandidate]()}}
	errUnavailable = httpapi.Kind{Tag: "Unavailable", Status: http.StatusConflict,
		Doc:   "No copy can be read now. volumes lists the detached disks that hold one. It is empty when the copies on attached disks are missing, changed since their scan, or excluded by the server's content rules.",
		Extra: map[string]reflect.Type{"volumes": reflect.TypeFor[[]retrieve.OfflineVolume]()}}
)

// fail turns a store or retrieval error into the documented failure.
func fail(err error) error {
	if ambiguous, ok := errors.AsType[*store.AmbiguousRefError](err); ok {
		return AmbiguousRef.New(err.Error()).With("candidates", ambiguous.Candidates)
	}
	if unavailable, ok := errors.AsType[*retrieve.UnavailableError](err); ok {
		// Never nil, so the documented list is present even when it is empty.
		volumes := append([]retrieve.OfflineVolume{}, unavailable.Volumes...)
		e := errUnavailable.New(err.Error()).With("volumes", volumes)
		if len(volumes) > 0 {
			return e.Recover("Connect a listed volume",
				"Ask the owner to attach one of the listed disks to the machine serving attic, then retry.")
		}
		return e.Recover("Check the attached copies",
			"The copies on attached disks are missing, changed since their scan, or excluded by the server's content rules. Ask the owner to rescan the volume or review the rules; message says which copies failed.")
	}
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound.New(err.Error())
	}
	if _, ok := errors.AsType[*store.InvalidSearchError](err); ok {
		return httpapi.Invalid.New(err.Error())
	}
	slog.Error("request failed", "err", err)
	return httpapi.Internal.New(err.Error())
}
