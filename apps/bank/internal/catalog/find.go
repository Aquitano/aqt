package catalog

import (
	"context"
	"errors"
	"fmt"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var ErrFilters = errors.New("incompatible search filters")

type Reader interface {
	Search(context.Context, string, store.SearchOpts) ([]store.Message, error)
	SearchLibrary(context.Context, library.ListOptions) (library.SearchResult, error)
	AttachmentLibrary(context.Context, store.AttachmentFilter) ([]store.LibraryFile, error)
}

type Result struct {
	library.SearchResult
	Messages    []store.Message     `json:"messages"`
	Attachments []store.LibraryFile `json:"attachments"`
}

func Find(ctx context.Context, reader Reader, query string, messages store.SearchOpts, options library.ListOptions) (Result, error) {
	result := Result{Messages: []store.Message{}, Attachments: []store.LibraryFile{}, SearchResult: library.SearchResult{
		Items: []library.Item{}, Activity: []library.Activity{}, Collections: []library.CollectionSummary{},
		Files: []library.File{}, Pages: []library.Page{}, Coverage: []string{},
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
	if options.Account != "" {
		result.Coverage = append(result.Coverage, "Account filters apply to the library. Correspondence is excluded because its account model differs.")
	}
	if !mailOnly && options.Kind != "message" && (options.Since != "" || options.Until != "" || !messages.Since.IsZero() || !messages.Until.IsZero()) {
		result.Coverage = append(result.Coverage, "Date filters apply to correspondence, activity and message attachments. Items, collections, standalone files and pages have no event date and are returned without date filtering.")
	}
	return result, nil
}
