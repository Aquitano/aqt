// Package httpapi is how every domain describes its HTTP operations, so one
// OpenAPI document per API is generated from the Go types and failures look
// the same everywhere. Agents are the callers: code-mode hosts turn the
// document into typed functions, and branch on a failure's _tag.
package httpapi

import (
	"bytes"
	"cmp"
	"encoding/json"
	"maps"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
)

// Error is every error body. _tag names the failure so agent code can branch
// on it, message says what happened, and recovery, where the caller can act,
// says what to do next. A kind may add fields of its own.
type Error struct {
	status   int
	Tag      string
	Message  string
	Recovery *Recovery
	extra    map[string]any
}

type Recovery struct {
	Action       string `json:"action"`
	Instructions string `json:"instructions"`
}

func (e *Error) Error() string  { return e.Message }
func (e *Error) GetStatus() int { return e.status }

// With sets one of the fields the error's kind documents in Extra.
func (e *Error) With(field string, value any) *Error {
	if e.extra == nil {
		e.extra = map[string]any{}
	}
	e.extra[field] = value
	return e
}

func (e *Error) Recover(action, instructions string) *Error {
	e.Recovery = &Recovery{Action: action, Instructions: instructions}
	return e
}

func (e *Error) MarshalJSON() ([]byte, error) {
	fields := map[string]any{"_tag": e.Tag, "message": e.Message}
	if e.Recovery != nil {
		fields["recovery"] = e.Recovery
	}
	maps.Copy(fields, e.extra)
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	err := enc.Encode(fields)
	return bytes.TrimSpace(b.Bytes()), err
}

// Kind is one documented failure. Each gets its own schema with _tag as a
// literal, so generated clients can tell failures that share a status apart.
type Kind struct {
	Tag    string
	Status int
	Doc    string
	Extra  map[string]reflect.Type
}

var (
	Unauthorized = Kind{Tag: "Unauthorized", Status: http.StatusUnauthorized,
		Doc: "The bearer token is missing or unknown."}
	Forbidden = Kind{Tag: "Forbidden", Status: http.StatusForbidden,
		Doc: "The token is valid, and its scope does not allow the request."}
	Invalid = Kind{Tag: "InvalidRequest", Status: http.StatusUnprocessableEntity,
		Doc: "A parameter is malformed, out of range or contradicts another."}
	NotFound = Kind{Tag: "NotFound", Status: http.StatusNotFound,
		Doc: "Nothing matches."}
	Internal = Kind{Tag: "Internal", Status: http.StatusInternalServerError,
		Doc: "The server failed; message says how."}
	// A host answers NotReady before an API exists, so no operation documents it.
	NotReady = Kind{Tag: "NotReady", Status: http.StatusServiceUnavailable}
)

// EveryOperation can fail on any route: authentication, parameter validation
// or the server itself.
var EveryOperation = []Kind{Unauthorized, Forbidden, Invalid, Internal}

func (k Kind) New(message string) *Error {
	return &Error{status: k.Status, Tag: k.Tag, Message: message}
}

func (k Kind) schemaName() string { return k.Tag + "Error" }

// Responses documents kinds, plus the failures every operation shares, as an
// operation's error responses: one schema per kind, anyOf where a status has
// several.
func Responses(registry huma.Registry, kinds ...Kind) map[string]*huma.Response {
	byStatus := map[int][]Kind{}
	for _, k := range append(slices.Clone(EveryOperation), kinds...) {
		if _, ok := registry.Map()[k.schemaName()]; !ok {
			registry.Map()[k.schemaName()] = k.schema(registry)
		}
		byStatus[k.Status] = append(byStatus[k.Status], k)
	}
	out := map[string]*huma.Response{}
	for status, ks := range byStatus {
		refs := make([]*huma.Schema, len(ks))
		docs := make([]string, len(ks))
		for i, k := range ks {
			refs[i] = &huma.Schema{Ref: "#/components/schemas/" + k.schemaName()}
			docs[i] = k.Tag + ": " + strings.ToLower(k.Doc[:1]) + k.Doc[1:]
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

func (k Kind) schema(registry huma.Registry) *huma.Schema {
	s := &huma.Schema{
		Type:        "object",
		Description: k.Doc,
		Required:    []string{"_tag", "message"},
		Properties: map[string]*huma.Schema{
			"_tag":    {Type: "string", Enum: []any{k.Tag}},
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
	for name, t := range k.Extra {
		s.Properties[name] = registry.Schema(t, true, name)
		s.Required = append(s.Required, name)
	}
	slices.Sort(s.Required)
	return s
}

// Operation is one route. Its error responses are Errors plus EveryOperation.
type Operation struct {
	ID, Method, Path, Tag, Summary, Description string
	Errors                                      []Kind
}

func (o Operation) For(api huma.API) huma.Operation {
	return huma.Operation{
		OperationID: o.ID, Method: o.Method, Path: o.Path, Tags: []string{o.Tag},
		Summary: o.Summary, Description: o.Description,
		Responses: Responses(api.OpenAPI().Components.Schemas, o.Errors...),
	}
}

// Finish removes the schema Huma adds for its own error type. Call it after
// the last Register: every operation declares its errors.
func Finish(api huma.API) {
	delete(api.OpenAPI().Components.Schemas.Map(), "Error")
}

// Body is a JSON response.
type Body[T any] struct {
	Body T
}

// Config is the Huma configuration every API shares. mintCommand is what the
// owner runs for a token; basePath precedes every route when a host mounts
// the API below its root.
func Config(title, description, mintCommand, basePath string) huma.Config {
	cfg := huma.DefaultConfig(title, "1")
	cfg.Info.Description = description
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	// The default hooks add a $schema link to every body; agents gain nothing from it.
	cfg.CreateHooks = nil
	cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"bearer": {Type: "http", Scheme: "bearer", Description: "A token from `" + mintCommand + "`."},
	}
	cfg.Security = []map[string][]string{{"bearer": {}}}
	if basePath != "" {
		cfg.Servers = []*huma.Server{{URL: basePath}}
	}
	return cfg
}

// Write sends e outside a Huma handler, such as from authentication.
func Write(w http.ResponseWriter, e *Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(e)
}

// Huma reports parameter validation and its own failures through NewError.
// The hook is process-wide by Huma's design, which is why every API in this
// module shares this package.
func init() {
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		kind := Internal
		switch {
		case status == http.StatusUnauthorized:
			kind = Unauthorized
		case status == http.StatusForbidden:
			kind = Forbidden
		case status == http.StatusNotFound:
			kind = NotFound
		case status >= 400 && status < 500:
			kind = Invalid
		}
		details := []string{msg}
		for _, err := range errs {
			if err != nil {
				details = append(details, err.Error())
			}
		}
		return &Error{status: cmp.Or(status, kind.Status), Tag: kind.Tag, Message: strings.Join(details, ": ")}
	}
}
