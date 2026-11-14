// Package httpapi is how every route describes its HTTP operation, so the one
// OpenAPI document is generated from the Go types, failures look the same
// everywhere, and a token's scope is checked in one place. Agents are the
// callers: code-mode hosts turn the document into typed functions, and branch
// on a failure's _tag.
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/tokens"
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
		Doc: "The token is valid and only reads; this operation writes."}
	Invalid = Kind{Tag: "InvalidRequest", Status: http.StatusUnprocessableEntity,
		Doc: "A parameter or the body is malformed, too large, out of range or contradicts another."}
	NotFound = Kind{Tag: "NotFound", Status: http.StatusNotFound,
		Doc: "Nothing matches."}
	Internal = Kind{Tag: "Internal", Status: http.StatusInternalServerError,
		Doc: "The server failed; message says how."}
)

// EveryOperation can fail on any route: authentication, parameter validation
// or the server itself. An operation that writes can also be Forbidden.
var EveryOperation = []Kind{Unauthorized, Invalid, Internal}

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
// Writes marks an operation that changes the archive, which a read token may
// not call; an operation that takes a body and only reads, such as a search
// by POST, leaves it false. Tool offers the operation to agents as a tool of
// bank mcp, and the document marks it with ToolExtension.
type Operation struct {
	ID, Method, Path, Tag, Summary, Description string
	Errors                                      []Kind
	Writes, Tool                                bool
}

// ToolExtension marks an operation that agents are offered as a tool.
const ToolExtension = "x-agent-tool"

// writeRole is the role an operation that writes requires of the bearer
// token. OpenAPI 3.1 lets a security requirement name roles for any scheme.
const writeRole = "write"

func (o Operation) For(api huma.API) huma.Operation {
	op := huma.Operation{
		OperationID: o.ID, Method: o.Method, Path: o.Path, Tags: []string{o.Tag},
		Summary: o.Summary, Description: o.Description,
	}
	if o.Tool {
		op.Extensions = map[string]any{ToolExtension: true}
	}
	errs := o.Errors
	if o.Writes {
		op.Security = []map[string][]string{{"bearer": {writeRole}}}
		errs = append([]Kind{Forbidden}, errs...)
	}
	op.Responses = Responses(api.OpenAPI().Components.Schemas, errs...)
	return op
}

// Writes says whether op, as registered, changes the archive.
func Writes(op *huma.Operation) bool {
	return slices.ContainsFunc(op.Security, func(requirement map[string][]string) bool {
		return slices.Contains(requirement["bearer"], writeRole)
	})
}

// RequireToken is the one check of every operation: the bearer token must be
// in store, and a read token may not call an operation that writes. A token
// file that cannot be read is the server's failure, not the caller's.
func RequireToken(api huma.API, store tokens.Store, mintCommand string) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		token, _ := bearerToken(ctx.Header("Authorization"))
		scope, ok, err := store.Verify(token)
		switch {
		case err != nil:
			slog.Error("read tokens", "error", err)
			_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "the server could not read its token file")
		case !ok:
			ctx.SetHeader("WWW-Authenticate", "Bearer")
			_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, "send Authorization: Bearer <token>; the owner mints one with `"+mintCommand+"`")
		case !scope.Allows(Writes(ctx.Operation())):
			_ = huma.WriteErr(api, ctx, http.StatusForbidden, "this token only reads, and "+ctx.Operation().OperationID+" writes")
		default:
			next(ctx)
		}
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

// Config is the Huma configuration of the API. mintCommand is what the owner
// runs for a token.
func Config(title, description, mintCommand string) huma.Config {
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
	return cfg
}

// bearerToken is the token in an Authorization header. The scheme is
// case-insensitive, as RFC 7235 says.
func bearerToken(header string) (string, bool) {
	scheme, token, ok := strings.Cut(header, " ")
	return token, ok && strings.EqualFold(scheme, "bearer") && token != ""
}

// PageSize is the limit every list and search takes. Struct tags cannot name
// constants, so a test keeps these equal to the page package's.
type PageSize struct {
	Limit int `query:"limit" default:"20" minimum:"1" maximum:"500" doc:"How many results, at most."`
}

// Page is PageSize with an offset, for lists that page by position.
type Page struct {
	PageSize
	Offset int `query:"offset" default:"0" minimum:"0" maximum:"10000" doc:"Skip this many results. Past the maximum, narrow the request instead of paging deeper."`
}

// Write sends e outside a Huma operation: from /healthz, or for a path no
// operation serves.
func Write(w http.ResponseWriter, e *Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(e)
}

// Huma reports parameter validation and its own failures through NewError,
// and the hook is process-wide by Huma's design. Each status Huma chooses is
// normalised to a documented kind and that kind's status: a malformed, too
// large or too slow body is an InvalidRequest at 422 like any rejected
// parameter, so the document lists every status a caller can see. A server
// failure is logged and its cause is not sent.
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
			// A detail's value can be the whole body the caller sent.
			if detail, ok := errors.AsType[*huma.ErrorDetail](err); ok && detail.Location != "" {
				details = append(details, detail.Location+": "+detail.Message)
			} else if err != nil {
				details = append(details, err.Error())
			}
		}
		message := strings.Join(details, ": ")
		// Huma also calls this with status 0 while it builds the document.
		if status >= http.StatusInternalServerError {
			slog.Error("HTTP request failed", "status", status, "error", message)
			message = http.StatusText(http.StatusInternalServerError)
		}
		return kind.New(message)
	}
}
