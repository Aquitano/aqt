package catalog

import (
	"context"
	"errors"
	"fmt"

	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var ErrFilters = errors.New("incompatible search filters")

type Reader interface {
	Search(context.Context, string, store.SearchOpts) ([]store.Message, error)
	SearchLibrary(context.Context, library.ListOptions) (library.SearchResult, error)
	AttachmentLibrary(context.Context, store.AttachmentFilter) ([]store.LibraryFile, error)
}

// Disks is the catalogue of files that live on disks, not in the archive.
type Disks interface {
	SearchDisks(ctx context.Context, query string, limit, offset int) (view.SearchResult, error)
}

type Result struct {
	library.SearchResult
	Messages    []store.Message     `json:"messages"`
	Attachments []store.LibraryFile `json:"attachments"`
	Disks       view.SearchResult   `json:"disks"`
}

// Find searches every kind of record. disks may be nil.
func Find(ctx context.Context, reader Reader, disks Disks, query string, messages store.SearchOpts, options library.ListOptions) (Result, error) {
	result := Result{Messages: []store.Message{}, Attachments: []store.LibraryFile{}, SearchResult: library.SearchResult{
		Items: []library.Item{}, Activity: []library.Activity{}, Collections: []library.CollectionSummary{},
		Files: []library.File{}, Pages: []library.Page{}, Coverage: []string{},
	}, Disks: view.SearchResult{
		Entries: []view.Place{}, Members: []view.MemberMatch{}, Texts: []view.TextMatch{},
		Metadata: []view.TextMatch{}, Analyses: []view.AnalysisMatch{},
	}}
	if err := messages.ValidateQuery(query); err != nil {
		return result, err
	}
	options.Query = query
	options.Match = messages.Match
	if err := options.Validate(); err != nil {
		return result, err
	}
	mailOnly := messages.From != "" || messages.To != "" || messages.Person != "" || messages.MailboxID != 0 || messages.Subject != "" || messages.HasAttachment != nil
	if mailOnly && options.Kind != "" && options.Kind != "message" {
		return result, fmt.Errorf("message filters cannot be combined with kind %s: %w", options.Kind, ErrFilters)
	}
	if options.Account != "" && (mailOnly || options.Kind == "message") {
		return result, fmt.Errorf("account cannot be combined with correspondence filters: %w", ErrFilters)
	}
	var err error
	if (options.Kind == "" || options.Kind == "message") && options.Account == "" {
		result.Messages, err = reader.Search(ctx, query, messages)
		if err != nil {
			return result, err
		}
		if result.Messages == nil {
			result.Messages = []store.Message{}
		}
	}

	if options.Kind != "message" && !mailOnly {
		result.SearchResult, err = reader.SearchLibrary(ctx, options)
		if err != nil {
			return result, err
		}
	} else if mailOnly {
		result.Coverage = append(result.Coverage, "Message-specific filters restrict this search to correspondence.")
	}
	if !mailOnly && options.Account == "" && (options.Kind == "" || options.Kind == "file") {
		result.Attachments, err = reader.AttachmentLibrary(ctx, store.AttachmentFilter{Query: query, Match: messages.Match, Source: messages.Source, Since: messages.Since, Until: messages.Until, Limit: messages.Limit, Offset: messages.Offset})
		if err != nil {
			return result, err
		}
		if result.Attachments == nil {
			result.Attachments = []store.LibraryFile{}
		}
	}
	dated := options.Since != "" || options.Until != "" || !messages.Since.IsZero() || !messages.Until.IsZero()
	if disks != nil && !mailOnly && !dated && options.Account == "" && messages.Source == "" && (options.Kind == "" || options.Kind == "file") {
		// The archive answers without the catalogue, which may still be migrating.
		if found, err := disks.SearchDisks(ctx, query, messages.Limit, messages.Offset); err != nil {
			result.Coverage = append(result.Coverage, "Files on disks are missing from this search: "+err.Error()+".")
		} else {
			result.Disks = found
		}
	}
	if options.Account != "" {
		result.Coverage = append(result.Coverage, "Account filters apply to the library. Correspondence is excluded because its account model differs.")
	}
	if !mailOnly && options.Kind != "message" && dated {
		result.Coverage = append(result.Coverage, "Date filters apply to correspondence, activity and message attachments. Items, collections, standalone files and pages have no event date and are returned without date filtering. Files on disks are left out.")
	}
	return result, nil
}
