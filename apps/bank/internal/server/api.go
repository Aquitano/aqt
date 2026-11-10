package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
)

const apiDescription = `bank is one person's archive: messages (mail, chats, AI conversations), a media
library with what was watched, listened to and read, files, and published notes. The
file catalogue of disks that come and go is served below /attic, with a document of
its own at /attic/openapi.json.

Cite a message as bank:<ref>, a library record by its ID, and a file on a disk as
attic:<ref>.

This document describes the operations defined from typed Go handlers. The older /v1
routes that the bank CLI uses are not in it yet.`

// registerAPI adds the operations that are described in /openapi.json. New
// routes belong here: their document is generated from the Go types, and
// their failures carry a _tag.
func (s *Server) registerAPI(mux *http.ServeMux) huma.API {
	api := humago.New(mux, httpapi.Config("bank", apiDescription, "bank token new <name>", ""))
	huma.Register(api, httpapi.Operation{ID: "getTimeline", Method: http.MethodGet, Path: "/v1/timeline", Tag: "timeline",
		Summary: "List what happened between two days, across messages, activity and files",
		Description: "Messages by when they were sent, activity (watching, listening, reading) by when it happened, " +
			"and files on disks by when they were last modified, merged oldest first. limit caps each group on " +
			"its own; truncated names the groups that reached it.",
	}.For(api), s.timeline)
	huma.Register(api, httpapi.Operation{ID: "resolveRef", Method: http.MethodGet, Path: "/v1/refs/{ref}", Tag: "refs",
		Summary: "Say what a cited ref names, whichever store holds it",
		Description: "Takes bank:<ref> or a bare message ref, a library ID such as item_… or file_…, a blob's SHA-256, " +
			"or attic:<ref>. The answer names the record, the route that returns it in full, and where the same " +
			"bytes are in the other store: a message attachment's copies on disks, or the messages and library " +
			"files that hold a disk file's bytes. Those links appear once the server has read the blob's BLAKE3 " +
			"digest, shortly after an import.",
		Errors: []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.resolve)
	httpapi.Finish(api)
	return api
}

// Spec is the OpenAPI document bank serve answers with, built without a database.
func Spec() ([]byte, error) {
	return json.MarshalIndent((&Server{}).registerAPI(http.NewServeMux()).OpenAPI(), "", "  ")
}

type resolveInput struct {
	Ref string `path:"ref" doc:"The ref as cited."`
}

func (s *Server) resolve(ctx context.Context, in *resolveInput) (*httpapi.Body[catalog.Resolved], error) {
	// A nil catalogue must reach Resolve as a nil interface.
	var contents catalog.Contents
	if s.catalogue != nil {
		contents = s.catalogue
	}
	resolved, err := catalog.Resolve(ctx, s.db, contents, in.Ref)
	if errors.Is(err, catalog.ErrNoRecord) {
		return nil, httpapi.NotFound.New(err.Error())
	}
	if err != nil {
		return nil, httpapi.Internal.New(err.Error())
	}
	return &httpapi.Body[catalog.Resolved]{Body: resolved}, nil
}

type timelineInput struct {
	Since string   `query:"since" required:"true" format:"date" doc:"First day, as YYYY-MM-DD in the server's time zone."`
	Until string   `query:"until" format:"date" doc:"The day after the last day. Default: the day after since."`
	Group []string `query:"group" enum:"message,activity,file" doc:"Only these groups. Default: all three."`
	Limit int      `query:"limit" default:"200" minimum:"1" maximum:"2000" doc:"Maximum events per group."`
}

func (s *Server) timeline(ctx context.Context, in *timelineInput) (*httpapi.Body[catalog.Timeline], error) {
	since, err := time.ParseInLocation(time.DateOnly, in.Since, time.Local)
	if err != nil {
		return nil, httpapi.Invalid.New("since is not a YYYY-MM-DD date")
	}
	until := since.AddDate(0, 0, 1)
	if in.Until != "" {
		if until, err = time.ParseInLocation(time.DateOnly, in.Until, time.Local); err != nil || !until.After(since) {
			return nil, httpapi.Invalid.New("until is a YYYY-MM-DD date after since")
		}
	}
	// A nil catalogue must reach BuildTimeline as a nil interface.
	var files catalog.Files
	if s.catalogue != nil {
		files = s.catalogue
	}
	result, err := catalog.BuildTimeline(ctx, s.db, files, catalog.TimelineOptions{Since: since, Until: until, Groups: in.Group, Limit: in.Limit})
	if err != nil {
		return nil, httpapi.Internal.New(err.Error())
	}
	return &httpapi.Body[catalog.Timeline]{Body: result}, nil
}
