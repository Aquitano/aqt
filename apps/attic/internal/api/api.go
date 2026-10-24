// Package api serves the catalogue over HTTP. Agents are its only users, so
// the OpenAPI document at /openapi.json is the contract: code-mode hosts turn
// it into typed functions, and every operation and field is described for a
// reader that sees nothing else.
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/store"
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
	tokens Tokens
}

// New serves the catalogue in st. cfg supplies the content rules a download
// respects; every /v1 route needs a bearer token from tokens.
func New(st *store.Store, cfg config.Config, tokens Tokens) http.Handler {
	mux := http.NewServeMux()
	s := &Server{store: st, config: cfg, tokens: tokens}
	s.register(humago.New(mux, apiConfig()))
	return s.authenticate(mux)
}

// Spec is the OpenAPI document, built without a catalogue.
func Spec() ([]byte, error) {
	api := humago.New(http.NewServeMux(), apiConfig())
	(&Server{}).register(api)
	return json.MarshalIndent(api.OpenAPI(), "", "  ")
}

func apiConfig() huma.Config {
	cfg := huma.DefaultConfig("attic", "1")
	cfg.Info.Description = description
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	// The default hooks add a $schema link to every body; agents gain nothing from it.
	cfg.CreateHooks = nil
	cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"bearer": {Type: "http", Scheme: "bearer", Description: "A token from `attic token new <name>`."},
	}
	cfg.Security = []map[string][]string{{"bearer": {}}}
	return cfg
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			ok, err := s.tokens.Verify(token)
			if err != nil {
				slog.Error("read tokens", "err", err)
				writeError(w, errInternal.new("the server could not read its token file"))
				return
			}
			if !ok {
				w.Header().Set("WWW-Authenticate", `Bearer realm="attic"`)
				writeError(w, errUnauthorized.new("send Authorization: Bearer <token>; the owner mints one with `attic token new <name>`"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeError(w http.ResponseWriter, e *apiError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(e)
}
