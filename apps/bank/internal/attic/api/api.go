// Package api serves the catalogue over HTTP. Agents are its only users, so
// the OpenAPI document at /openapi.json is the contract: code-mode hosts turn
// it into typed functions, and every operation and field is described for a
// reader that sees nothing else.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

const description = `attic catalogues files on disks that come and go. For every file it records
where it is (an entry: a path on a volume), what it is (a content, identified by its
BLAKE3 digest and cited as attic:<ref>), and the text, tags, OCR and image descriptions
read from it. It keeps no file bytes: a file can be downloaded only while a disk that
holds a copy is attached to the machine serving this API.

Places carry three flags. online: the disk is attached now. missing: the last scan of
its folder no longer found the file. version "previous": the entry held this content
before its bytes changed, so earlier versions of a file stay findable.

Cite a file by its content ref; entry IDs name a location in this catalogue only.`

type Server struct {
	store  *store.Store
	config config.Config
	host   Host
}

// TokenDomain is the domain a scoped token needs for the catalogue.
const TokenDomain = "attic"

// Host is the server the API runs in: `attic serve` beside the disks, or
// bank's server, which mounts it under BasePath with bank's own tokens.
type Host struct {
	Tokens tokens.Store
	// MintCommand is what the owner runs for a token; error messages and the
	// OpenAPI document name it.
	MintCommand string
	// BasePath precedes every route, such as /attic. Empty serves at the root.
	BasePath string
}

// Standalone is the host `attic serve` provides.
func Standalone(tokens tokens.Store) Host {
	return Host{Tokens: tokens, MintCommand: "attic token new <name>"}
}

// DefaultTokens keeps the token file beside attic's configuration.
func DefaultTokens() (tokens.Store, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return tokens.Store{}, err
	}
	return tokens.Store{Path: filepath.Join(dir, "attic", "tokens"), Prefix: "attic_"}, nil
}

// New serves the catalogue in st. cfg supplies the content rules a download
// respects; every /v1 route needs a bearer token from host.
func New(st *store.Store, cfg config.Config, host Host) http.Handler {
	mux := http.NewServeMux()
	s := &Server{store: st, config: cfg, host: host}
	s.register(humago.New(mux, apiConfig(host)))
	return http.StripPrefix(host.BasePath, s.authenticate(mux))
}

// Spec is the OpenAPI document `attic serve` answers with, built without a
// catalogue.
func Spec() ([]byte, error) {
	api := humago.New(http.NewServeMux(), apiConfig(Standalone(tokens.Store{})))
	(&Server{}).register(api)
	return json.MarshalIndent(api.OpenAPI(), "", "  ")
}

func apiConfig(host Host) huma.Config {
	cfg := huma.DefaultConfig("attic", "1")
	cfg.Info.Description = description
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	// The default hooks add a $schema link to every body; agents gain nothing from it.
	cfg.CreateHooks = nil
	cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"bearer": {Type: "http", Scheme: "bearer", Description: "A token from `" + host.MintCommand + "`."},
	}
	cfg.Security = []map[string][]string{{"bearer": {}}}
	if host.BasePath != "" {
		cfg.Servers = []*huma.Server{{URL: host.BasePath}}
	}
	return cfg
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			scope, ok, err := s.host.Tokens.Verify(token)
			if err != nil {
				slog.Error("read tokens", "err", err)
				writeError(w, errInternal.new("the server could not read its token file"))
				return
			}
			if !ok {
				w.Header().Set("WWW-Authenticate", `Bearer realm="attic"`)
				writeError(w, errUnauthorized.new("send Authorization: Bearer <token>; the owner mints one with `"+s.host.MintCommand+"`"))
				return
			}
			if !scope.Allows(TokenDomain, false) {
				writeError(w, errForbidden.new("this token's scope ("+scope.String()+") does not open the catalogue"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// NotReady answers for a catalogue its host has not opened yet.
func NotReady(w http.ResponseWriter) {
	e := errNotReady.new("the catalogue is migrating or its migration failed; the server log says which")
	e.Recovery = &recovery{Action: "Retry later", Instructions: "Retry in a minute. If it persists, ask the owner to read the server log."}
	writeError(w, e)
}

func writeError(w http.ResponseWriter, e *apiError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(e)
}
