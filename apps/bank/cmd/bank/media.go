package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/find"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources/media"
)

func printLibrary[T any](value T, err error) error {
	if err != nil {
		return err
	}
	return printJSON(value)
}

// readJSON decodes the one JSON value in a file, or in stdin for -.
func readJSON(path string, dst json.Unmarshaler) error {
	raw, err := readInput(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}

// libraryCmd holds every filter on the group, as before the move to kong: any
// library command accepts them, and the listing commands are the ones that
// read most of them.
type libraryCmd struct {
	Match             string `default:"any" help:"any, all words, or phrase."`
	Source            string `help:"Source identity."`
	Account           string `help:"Source account."`
	Kind              string `help:"Record kind."`
	ItemID            string `help:"Item a file belongs to."`
	Since             string `help:"YYYY-MM-DD or RFC 3339."`
	Until             string `help:"YYYY-MM-DD or RFC 3339."`
	Limit             int    `default:"${limit}" help:"Page size, 1-${max_limit}."`
	Offset            int    `help:"Skip this many records, at most ${max_offset}."`
	JSON              bool   `help:"Accepted for symmetry; library output is always JSON."`
	MaxSensitivity    string `default:"normal" help:"Maximum Markdown sensitivity for index: normal, personal or confidential."`
	AllowConfidential bool   `help:"Explicitly publish confidential Markdown pages."`

	List             libraryListCmd             `cmd:"" help:"Items matching a query."`
	Activity         libraryListCmd             `cmd:"" help:"Activity matching a query."`
	Collections      libraryListCmd             `cmd:"" help:"Collections matching a query."`
	Files            libraryListCmd             `cmd:"" help:"Files matching a query."`
	Snapshots        librarySnapshotsCmd        `cmd:"" help:"A collection's snapshots."`
	Create           libraryCreateCmd           `cmd:"" help:"Create an item from JSON."`
	CollectionCreate libraryCollectionCreateCmd `cmd:"" name:"collection-create" help:"Create a collection from JSON."`
	State            libraryStateCmd            `cmd:"" help:"Replace an item's personal state from JSON."`
	CollectionEdit   libraryCollectionEditCmd   `cmd:"" name:"collection-edit" help:"Edit a collection from JSON."`
	Upload           libraryUploadCmd           `cmd:"" help:"Upload standalone files."`
	Index            libraryIndexCmd            `cmd:"" help:"Publish a directory of Markdown pages."`
	HelpCmd          helpCmd                    `cmd:"" name:"help" hidden:"" help:"Library commands."`
}

func (libraryCmd) Help() string {
	return "All library commands return JSON. Edits require expected_revision from the latest detail."
}

func (l *libraryCmd) filters(query string) server.LibraryFilters {
	return server.LibraryFilters{Q: query, Match: l.Match, Source: l.Source, Account: l.Account, Kind: l.Kind,
		ItemID: l.ItemID, Since: l.Since, Until: l.Until, Page: pageOf(l.Limit, l.Offset)}
}

type libraryListCmd struct {
	Query []string `arg:"" optional:""`
}

func (c *libraryListCmd) Run(ctx context.Context, kctx *kong.Context, lib *libraryCmd) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	filters := lib.filters(strings.Join(c.Query, " "))
	switch kctx.Selected().Name {
	case "activity":
		return printLibrary(client.Call(ctx, api, server.ListLibraryActivity, filters))
	case "collections":
		return printLibrary(client.Call(ctx, api, server.ListLibraryCollections, server.LibraryCollectionsInput{LibraryFilters: filters, Projection: "full"}))
	case "files":
		return printLibrary(client.Call(ctx, api, server.ListLibraryFiles, filters))
	default:
		return printLibrary(client.Call(ctx, api, server.ListLibraryItems, filters))
	}
}

type librarySnapshotsCmd struct {
	ID string `arg:"" help:"The collection's ID, collection:<32 hex>."`
}

func (c *librarySnapshotsCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	return printLibrary(client.Call(ctx, api, server.ListLibraryCollectionSnapshots, server.SnapshotsInput{ID: c.ID, Projection: "full"}))
}

type libraryCreateCmd struct {
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryCreateCmd) Run(ctx context.Context) error {
	var in server.CreateLibraryItemInput
	if err := readJSON(c.Input, &in.Body); err != nil {
		return err
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	return printLibrary(client.Call(ctx, api, server.CreateLibraryItem, in))
}

type libraryCollectionCreateCmd struct {
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryCollectionCreateCmd) Run(ctx context.Context) error {
	var in server.CreateLibraryCollectionInput
	if err := readJSON(c.Input, &in.Body); err != nil {
		return err
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	return printLibrary(client.Call(ctx, api, server.CreateLibraryCollection, in))
}

type libraryStateCmd struct {
	ID    string `arg:""`
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryStateCmd) Run(ctx context.Context) error {
	in := server.LibraryStateInput{ID: c.ID}
	if err := readJSON(c.Input, &in.Body); err != nil {
		return err
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	return printLibrary(client.Call(ctx, api, server.SetLibraryItemState, in))
}

type libraryCollectionEditCmd struct {
	ID    string `arg:""`
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryCollectionEditCmd) Run(ctx context.Context) error {
	in := server.CollectionEditInput{ID: c.ID}
	if err := readJSON(c.Input, &in.Body); err != nil {
		return err
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	return printLibrary(client.Call(ctx, api, server.EditLibraryCollection, in))
}

type libraryUploadCmd struct {
	Paths []string `arg:"" name:"file"`
}

func (c *libraryUploadCmd) Run(ctx context.Context, lib *libraryCmd) error {
	for _, path := range c.Paths {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("not a regular file: %s", path)
		}
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	in := server.UploadLibraryFilesInput{Source: lib.Source, Account: lib.Account, ItemID: lib.ItemID}
	return printLibrary(client.Upload(ctx, api, server.UploadLibraryFiles, in, client.Files(c.Paths)))
}

type libraryIndexCmd struct {
	Dir string `arg:"" name:"directory"`
}

func (c *libraryIndexCmd) Run(ctx context.Context, lib *libraryCmd) error {
	opts := media.PublicationOptions{Source: cmp.Or(lib.Source, "brain"), Account: lib.Account, MaxSensitivity: lib.MaxSensitivity, AllowConfidential: lib.AllowConfidential}
	publication, err := media.BuildPublication(c.Dir, opts)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(publication)
	if err != nil {
		return err
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	return importReader(ctx, api, "markdown", "publication.json", bytes.NewReader(encoded), nil)
}

func printCatalog(result find.Result, limit, offset int) error {
	for _, h := range result.Hits {
		cited := h.Ref
		if cited == "" && len(h.Places) > 0 {
			cited = fmt.Sprintf("entry %d", h.Places[0].EntryID)
		}
		title := h.Title
		if h.At != nil {
			layout := "2006-01-02 15:04"
			if h.DayOnly {
				layout = "2006-01-02"
			}
			title = h.At.Local().Format(layout) + "  " + title
		}
		fmt.Printf("%-11s %s  %s\n", cmp.Or(h.Type, h.Kind), cited, title)
		if h.Snippet != "" && h.Snippet != h.Title {
			fmt.Printf("              %s\n", excerpt(h.Snippet, 160))
		}
		for i, p := range h.Places {
			if i == 3 {
				fmt.Printf("              and %d more places\n", h.PlaceCount-3)
				break
			}
			fmt.Printf("              %s\n", describePlace(p))
		}
	}
	if len(result.Hits) == 0 {
		fmt.Println("no matches")
	}
	var found []string
	for _, c := range result.Counts {
		found = append(found, fmt.Sprintf("%d %s", c.Matches, c.Kind))
	}
	if len(found) > 0 {
		fmt.Printf("\nmatches: %s\n", strings.Join(found, ", "))
	}
	for _, note := range result.Coverage {
		fmt.Printf("note: %s\n", note)
	}
	printMorePages(len(result.Hits), limit, offset)
	return nil
}

func describePlace(p search.FilePlace) string {
	switch p.Kind {
	case "message":
		return "attached to " + p.Ref + " as " + p.Name
	case "library_file":
		return "library file " + p.Ref + ": " + p.Name
	}
	state := ""
	if p.Missing {
		state = " (missing)"
	}
	if p.Previous {
		state += " (previous version)"
	}
	return fmt.Sprintf("on disk %s: %s, entry %d%s", p.Volume, p.Path, p.EntryID, state)
}
