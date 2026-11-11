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
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
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
	return httpapi.Config("attic", description, host.MintCommand, host.BasePath)
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			scope, ok, err := s.host.Tokens.Verify(token)
			if err != nil {
				slog.Error("read tokens", "err", err)
				httpapi.Write(w, httpapi.Internal.New("the server could not read its token file"))
				return
			}
			if !ok {
				w.Header().Set("WWW-Authenticate", `Bearer realm="attic"`)
				httpapi.Write(w, httpapi.Unauthorized.New("send Authorization: Bearer <token>; the owner mints one with `"+s.host.MintCommand+"`"))
				return
			}
			if !scope.Allows(TokenDomain, false) {
				httpapi.Write(w, httpapi.Forbidden.New("this token's scope ("+scope.String()+") does not open the catalogue"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// NotReady answers for a catalogue its host has not opened yet.
func NotReady(w http.ResponseWriter) { httpapi.Write(w, NotReadyError()) }

func NotReadyError() *httpapi.Error {
	return httpapi.NotReady.New("the catalogue is migrating or its migration failed; the server log says which").
		Recover("Retry later", "Retry in a minute. If it persists, ask the owner to read the server log.")
}
