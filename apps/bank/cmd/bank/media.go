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

	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/server"
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
	Get              libraryGetCmd              `cmd:"" help:"Any record by id: item:, activity:, collection:, file: or page:."`
	Collection       libraryGetCmd              `cmd:"" help:"One collection."`
	File             libraryGetCmd              `cmd:"" help:"One file."`
	Page             libraryGetCmd              `cmd:"" help:"One page."`
	Snapshots        libraryGetCmd              `cmd:"" help:"A collection's snapshots."`
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

type libraryGetCmd struct {
	ID string `arg:""`
}

func (c *libraryGetCmd) Run(ctx context.Context, kctx *kong.Context) error {
	kind := kctx.Selected().Name
	if kind == "get" {
		r, err := ref.Parse(c.ID)
		if err != nil {
			return err
		}
		if kind = string(r.Kind()); kind == string(ref.KindMessage) || kind == string(ref.KindContent) {
			return fmt.Errorf("%s is not a library record; use bank ref", c.ID)
		}
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	id := server.LibraryIDInput{ID: c.ID}
	switch kind {
	case "activity":
		return printLibrary(client.Call(ctx, api, server.GetLibraryActivity, id))
	case "collection":
		return printLibrary(client.Call(ctx, api, server.GetLibraryCollection, id))
	case "file":
		return printLibrary(client.Call(ctx, api, server.GetLibraryFile, id))
	case "page":
		return printLibrary(client.Call(ctx, api, server.GetLibraryPage, id))
	case "snapshots":
		return printLibrary(client.Call(ctx, api, server.ListLibraryCollectionSnapshots, server.SnapshotsInput{ID: c.ID, Projection: "full"}))
	}
	return printLibrary(client.Call(ctx, api, server.GetLibraryItem, id))
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
	opts := mediaimport.PublicationOptions{Source: cmp.Or(lib.Source, "brain"), Account: lib.Account, MaxSensitivity: lib.MaxSensitivity, AllowConfidential: lib.AllowConfidential}
	publication, err := mediaimport.BuildPublication(c.Dir, opts)
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

func printCatalog(result catalog.Result, limit, offset int) error {
	count := 0
	largest := 0
	report := func(kind, id, title string) { fmt.Printf("%-11s %s  %s\n", kind, id, title); count++ }
	for _, m := range result.Messages {
		title := m.Subject
		if title == "" {
			title = excerpt(m.Body, 100)
		}
		report("message", m.Ref, title)
		if m.Snippet != "" && m.Snippet != title {
			fmt.Printf("              %s\n", excerpt(m.Snippet, 160))
		}
		if m.AttachmentSnippet != "" {
			fmt.Printf("              in attachment: %s\n", excerpt(m.AttachmentSnippet, 160))
		}
	}
	for _, v := range result.Items {
		report(v.Kind, v.ID, v.Title)
	}
	for _, v := range result.Activity {
		date := v.Occurred.Value
		if date == "" {
			date = "date unknown"
		}
		report(v.Kind, v.ID, date+"  "+v.Title)
	}
	for _, v := range result.Collections {
		report("collection", v.ID, v.Title)
	}
	for _, v := range result.Files {
		report("file", v.ID, v.Filename)
	}
	for _, v := range result.Pages {
		report("page", v.ID, v.Title)
	}
	for _, v := range result.Attachments {
		report("attachment", v.BLAKE3.String(), v.Filename)
	}
	for _, v := range result.Disks.Entries {
		report("on disk", cmp.Or(v.Ref, "-"), v.Display)
	}
	for _, v := range result.Disks.Members {
		report("in archive", cmp.Or(v.Shown.Ref, "-"), v.Display)
	}
	for _, group := range [][]view.TextMatch{result.Disks.Texts, result.Disks.Metadata} {
		for _, v := range group {
			report("disk text", cmp.Or(v.Ref, "-"), v.Display)
			fmt.Printf("              %s\n", excerpt(v.Snippet, 160))
		}
	}
	for _, v := range result.Disks.Analyses {
		report("disk image", cmp.Or(v.Ref, "-"), v.Display)
		fmt.Printf("              %s\n", excerpt(v.Snippet, 160))
	}
	for _, n := range []int{len(result.Messages), len(result.Items), len(result.Activity), len(result.Collections), len(result.Files), len(result.Pages), len(result.Attachments),
		len(result.Disks.Entries), len(result.Disks.Members), len(result.Disks.Texts), len(result.Disks.Metadata), len(result.Disks.Analyses)} {
		if n > largest {
			largest = n
		}
	}
	if count == 0 {
		fmt.Println("no matches")
	}
	printMorePages(largest, limit, offset)
	return nil
}
