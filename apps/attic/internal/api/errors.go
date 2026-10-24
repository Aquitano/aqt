package api

import (
	"cmp"
	"errors"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/attic/internal/retrieve"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

// apiError is every error body. _tag names the failure so agent code can
// branch on it, message says what happened, and recovery, where the caller can
// act, says what to do next.
type apiError struct {
	status     int
	Tag        string                   `json:"_tag"`
	Message    string                   `json:"message"`
	Recovery   *recovery                `json:"recovery,omitempty"`
	Candidates []store.RefCandidate     `json:"candidates,omitempty"`
	Volumes    []retrieve.OfflineVolume `json:"volumes,omitempty"`
}

type recovery struct {
	Action       string `json:"action"`
	Instructions string `json:"instructions"`
}

func (e *apiError) Error() string  { return e.Message }
func (e *apiError) GetStatus() int { return e.status }

// errorKind is one documented failure. Each gets its own schema with _tag as a
// literal, so generated clients can tell failures that share a status apart.
type errorKind struct {
	tag    string
	status int
	doc    string
	extra  map[string]reflect.Type
}

var (
	errUnauthorized = errorKind{tag: "Unauthorized", status: http.StatusUnauthorized,
		doc: "The bearer token is missing or unknown."}
	errInvalid = errorKind{tag: "InvalidRequest", status: http.StatusUnprocessableEntity,
		doc: "A parameter is malformed, out of range or contradicts another."}
	errNotFound = errorKind{tag: "NotFound", status: http.StatusNotFound,
		doc: "No content, entry, volume or scan matches."}
	errAmbiguous = errorKind{tag: "AmbiguousRef", status: http.StatusConflict,
		doc:   "The ref prefix matches several contents. Retry with one of the candidates' longer refs.",
		extra: map[string]reflect.Type{"candidates": reflect.TypeFor[[]store.RefCandidate]()}}
	errUnavailable = errorKind{tag: "Unavailable", status: http.StatusConflict,
		doc:   "No copy can be read now. volumes lists the detached disks that hold one; an empty list means every attached copy is missing.",
		extra: map[string]reflect.Type{"volumes": reflect.TypeFor[[]retrieve.OfflineVolume]()}}
	errInternal = errorKind{tag: "Internal", status: http.StatusInternalServerError,
		doc: "The server failed; message says how."}
)

// everyOperation can fail on any route: authentication, parameter validation
// or the server itself. A catalogue at the wrong schema stops `attic serve`
// from starting instead.
var everyOperation = []errorKind{errUnauthorized, errInvalid, errInternal}

func (k errorKind) new(message string) *apiError {
	return &apiError{status: k.status, Tag: k.tag, Message: message}
}

func (k errorKind) schemaName() string { return k.tag + "Error" }

// responses documents kinds, plus the failures every operation shares, as the
// operation's error responses: one schema per kind, anyOf where a status has
// several.
func responses(registry huma.Registry, kinds ...errorKind) map[string]*huma.Response {
	byStatus := map[int][]errorKind{}
	for _, k := range append(slices.Clone(everyOperation), kinds...) {
		if _, ok := registry.Map()[k.schemaName()]; !ok {
			registry.Map()[k.schemaName()] = k.schema(registry)
		}
		byStatus[k.status] = append(byStatus[k.status], k)
	}
	out := map[string]*huma.Response{}
	for status, ks := range byStatus {
		refs := make([]*huma.Schema, len(ks))
		docs := make([]string, len(ks))
		for i, k := range ks {
			refs[i] = &huma.Schema{Ref: "#/components/schemas/" + k.schemaName()}
			docs[i] = k.tag + ": " + strings.ToLower(k.doc[:1]) + k.doc[1:]
		}
		schema := refs[0]
		if len(refs) > 1 {
			schema = &huma.Schema{AnyOf: refs}
		}
		out[strconv.Itoa(status)] = &huma.Response{
			Description: strings.Join(docs, " "),
			Content:     map[string]*huma.MediaType{"application/json": {Schema: schema}},
		}
	}
	return out
}

func (k errorKind) schema(registry huma.Registry) *huma.Schema {
	s := &huma.Schema{
		Type:        "object",
		Description: k.doc,
		Required:    []string{"_tag", "message"},
		Properties: map[string]*huma.Schema{
			"_tag":    {Type: "string", Enum: []any{k.tag}},
			"message": {Type: "string"},
			"recovery": {
				Type:     "object",
				Required: []string{"action", "instructions"},
				Properties: map[string]*huma.Schema{
					"action":       {Type: "string", Description: "What to do, in a few words."},
					"instructions": {Type: "string", Description: "How to do it."},
				},
			},
		},
	}
	for name, t := range k.extra {
		s.Properties[name] = registry.Schema(t, true, name)
		s.Required = append(s.Required, name)
	}
	slices.Sort(s.Required)
	return s
}

// fail turns a store or retrieval error into the documented failure.
func fail(err error) error {
	if ambiguous, ok := errors.AsType[*store.AmbiguousRefError](err); ok {
		e := errAmbiguous.new(err.Error())
		e.Candidates = ambiguous.Candidates
		return e
	}
	if unavailable, ok := errors.AsType[*retrieve.UnavailableError](err); ok {
		e := errUnavailable.new(err.Error())
		e.Volumes = unavailable.Volumes
		if e.Volumes == nil {
			e.Volumes = []retrieve.OfflineVolume{}
		}
		if len(unavailable.Volumes) > 0 {
			e.Recovery = &recovery{Action: "Connect a listed volume",
				Instructions: "Ask the owner to attach one of the listed disks to the machine serving attic, then retry."}
		} else {
			e.Recovery = &recovery{Action: "Rescan the volume",
				Instructions: "Every attached copy is missing or changed; a scan of its volume refreshes the catalogue."}
		}
		return e
	}
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound.new(err.Error())
	}
	return errInternal.new(err.Error())
}

// Huma reports parameter validation and its own failures through NewError.
// The hook is process-wide by Huma's design; this binary serves one API.
func init() {
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		kind := errInternal
		switch {
		case status == http.StatusUnauthorized:
			kind = errUnauthorized
		case status == http.StatusNotFound:
			kind = errNotFound
		case status >= 400 && status < 500:
			kind = errInvalid
		}
		details := []string{msg}
		for _, err := range errs {
			if err != nil {
				details = append(details, err.Error())
			}
		}
		return &apiError{status: cmp.Or(status, kind.status), Tag: kind.tag, Message: strings.Join(details, ": ")}
	}
}
