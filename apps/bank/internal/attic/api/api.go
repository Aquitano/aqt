// Package api describes the catalogue's operations below /v1/disk on bank's
// API. Agents are their only users, so every operation and field is described
// for a reader that sees nothing but the OpenAPI document.
package api

import (
	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/attic/session"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
)

// Tag names the catalogue's operations in the document.
const Tag = "disk"

const description = `The catalogue of files on disks that come and go. For every file it records
where it is (an entry: a path on a volume), what it is (a content, identified by its
BLAKE3 digest and cited as content:<hex>), and the text, tags, OCR and image descriptions
read from it. It keeps no file bytes, and the server is not the machine the disks attach
to: attic get on that machine copies a file.

A place is missing when the last scan of its folder no longer found the file, and has
version "previous" when the entry held this content before its bytes changed, so earlier
versions of a file stay findable.

Cite a file by its content ref; entry IDs name a location in this catalogue only.`

type server struct {
	store    *store.Store
	sessions *session.Manager
}

// Register adds the catalogue's operations, answered from st, and the scan
// operations, kept in sessions, to api. Both may be nil when only the
// document is wanted.
func Register(api huma.API, st *store.Store, sessions *session.Manager) {
	api.OpenAPI().Tags = append(api.OpenAPI().Tags, &huma.Tag{Name: Tag, Description: description})
	s := &server{store: st, sessions: sessions}
	s.register(api)
	s.registerScans(api)
}
