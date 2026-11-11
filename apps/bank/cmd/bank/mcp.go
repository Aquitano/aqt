package main

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type mcpCmd struct{}

func (mcpCmd) Run(ctx context.Context) error {
	r, closeReads, err := openReads(ctx)
	if err != nil {
		return err
	}
	defer closeReads()
	return newMCPServer(r).Run(ctx, &mcp.StdioTransport{})
}

const mcpInstructions = `bank is one person's archive: mail, chats, AI conversations, a media library, and
files on disks. Every answer carries stable refs. Cite a message as bank:<ref>, a
library record by its ID, and a file on a disk as attic:<ref>; the ref tool resolves
any of them later.`

type searchArgs struct {
	Query  string `json:"query" jsonschema:"Words to find in messages, attachment text, the media library and files on disks, all at once."`
	Source string `json:"source,omitempty" jsonschema:"Only this source, such as gmail, whatsapp or netflix."`
	Person string `json:"person,omitempty" jsonschema:"Only messages to or from this contact, across all their aliases."`
	Kind   string `json:"kind,omitempty" jsonschema:"Only this kind: message, item, activity, collection, file, page, or a media subtype."`
	Since  string `json:"since,omitempty" jsonschema:"First day, YYYY-MM-DD."`
	Until  string `json:"until,omitempty" jsonschema:"The day after the last, YYYY-MM-DD."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Results per group, 1 to 500. Default 20."`
	Offset int    `json:"offset,omitempty" jsonschema:"Skip this many results per group, for the next page."`
}

type refArgs struct {
	Ref string `json:"ref" jsonschema:"The ref as cited: bank:<ref>, attic:<ref>, a library ID or a blob's SHA-256."`
}

type timelineArgs struct {
	Period string   `json:"period" jsonschema:"A year (2019), a month (2019-03) or a day (2019-03-14)."`
	Groups []string `json:"groups,omitempty" jsonschema:"Only these groups: message, activity, file. Default: all three."`
	Limit  int      `json:"limit,omitempty" jsonschema:"Events per group. Default 200."`
}

type messageArgs struct {
	Ref string `json:"ref" jsonschema:"The message's ref, with or without bank:."`
}

type threadArgs struct {
	ThreadID string `json:"thread_id" jsonschema:"The thread_id a message carries."`
	Source   string `json:"source,omitempty" jsonschema:"The source the thread belongs to, as the message carries it."`
	Around   int64  `json:"around,omitempty" jsonschema:"Center the page on this message's numeric id."`
	Limit    int    `json:"limit,omitempty" jsonschema:"Messages per page, 1 to 2000. Default 100."`
}

func newMCPServer(r reads) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "bank", Version: buildVersion()}, &mcp.ServerOptions{Instructions: mcpInstructions})
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true}

	mcp.AddTool(s, &mcp.Tool{Name: "search", Annotations: readOnly,
		Description: "Search messages, attachment text, the media library and files on disks at once. " +
			"Messages carry a ref to cite as bank:<ref>; files on disks carry one to cite as attic:<ref>. " +
			"coverage says what the result does not prove.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchArgs) (*mcp.CallToolResult, catalog.Result, error) {
		o := store.SearchOpts{Source: in.Source, Person: in.Person, Match: "any", Fuzzy: 1, Limit: cmp.Or(in.Limit, 20), Offset: in.Offset}
		var err error
		if o.Since, err = parseDate(in.Since); err != nil {
			return nil, catalog.Result{}, err
		}
		if o.Until, err = parseDate(in.Until); err != nil {
			return nil, catalog.Result{}, err
		}
		if err := o.ValidateQuery(in.Query); err != nil {
			return nil, catalog.Result{}, err
		}
		found, err := r.Find(ctx, in.Query, o, library.ListOptions{Query: in.Query, Source: in.Source, Kind: in.Kind,
			Since: in.Since, Until: in.Until, Limit: o.Limit, Offset: o.Offset})
		return nil, found, err
	})

	mcp.AddTool(s, &mcp.Tool{Name: "ref", Annotations: readOnly,
		Description: "Say what a cited ref names, whichever store holds it, and where the same bytes are elsewhere: " +
			"a message attachment's copies on disks, or the messages and library files that hold a disk file's bytes.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in refArgs) (*mcp.CallToolResult, catalog.Resolved, error) {
		resolved, err := r.Resolve(ctx, in.Ref)
		return nil, resolved, err
	})

	mcp.AddTool(s, &mcp.Tool{Name: "timeline", Annotations: readOnly,
		Description: "List what happened in a year, a month or a day, oldest first: messages by when they were sent, " +
			"activity by when it happened, and files on disks by when they were last modified. truncated names " +
			"the groups that had more than limit events.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in timelineArgs) (*mcp.CallToolResult, catalog.Timeline, error) {
		since, until, err := period(in.Period)
		if err != nil {
			return nil, catalog.Timeline{}, err
		}
		events, err := r.Timeline(ctx, since, until, in.Groups, cmp.Or(in.Limit, 200))
		return nil, events, err
	})

	mcp.AddTool(s, &mcp.Tool{Name: "message", Annotations: readOnly,
		Description: "Show one message by its ref, with its body and attachments. An attachment's sha256 is the ref " +
			"to resolve for its copies on disks. thread_id and source open its conversation with the thread tool.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in messageArgs) (*mcp.CallToolResult, store.MessageDetail, error) {
		ref := strings.TrimPrefix(strings.TrimSpace(in.Ref), "bank:")
		if err := store.ValidRef(ref); err != nil {
			return nil, store.MessageDetail{}, err
		}
		m, err := r.GetMessageDetailByRef(ctx, ref)
		if errors.Is(err, store.ErrNotFound) {
			err = fmt.Errorf("no message has ref %s", ref)
		}
		return nil, m, err
	})

	mcp.AddTool(s, &mcp.Tool{Name: "thread", Annotations: readOnly,
		Description: "Read one conversation, oldest first. has_before and has_after say whether more messages lie " +
			"outside the page; around with an edge message's id moves the page.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in threadArgs) (*mcp.CallToolResult, store.Thread, error) {
		thread, err := r.GetThreadPage(ctx, in.Source, in.ThreadID, store.ThreadOpts{Limit: cmp.Or(in.Limit, 100), Around: in.Around})
		if errors.Is(err, store.ErrNotFound) {
			err = fmt.Errorf("no thread %q", in.ThreadID)
		}
		return nil, thread, err
	})
	return s
}
