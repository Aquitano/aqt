package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

type libraryBackend interface {
	ListLibraryItems(context.Context, library.ListOptions) ([]library.Item, error)
	ListLibraryActivity(context.Context, library.ListOptions) ([]library.Activity, error)
	ListLibraryCollections(context.Context, library.ListOptions) ([]library.Collection, error)
	ListLibraryFiles(context.Context, library.ListOptions) ([]library.File, error)
	LibraryItem(context.Context, string) (library.Item, error)
	LibraryActivity(context.Context, string) (library.Activity, error)
	LibraryCollection(context.Context, string) (library.Collection, error)
	LibraryCollectionSnapshots(context.Context, string) ([]library.Snapshot, error)
	LibraryFile(context.Context, string) (library.File, error)
	LibraryPage(context.Context, string) (library.Page, error)
	SetLibraryState(context.Context, string, library.StateEdit) (library.State, error)
	CreateLibraryCollection(context.Context, library.Collection) (library.Collection, error)
	EditLibraryCollection(context.Context, string, library.CollectionEdit) (library.Collection, error)
}

func openLibraryBackend(ctx context.Context) (libraryBackend, func(), error) {
	if remote := client.FromEnv(); remote != nil {
		return remote, func() {}, nil
	}
	st, err := openStore(ctx)
	if err != nil {
		return nil, nil, err
	}
	return st, st.Close, nil
}

func printLibrary[T any](value T, err error) error {
	if err != nil {
		return err
	}
	return printJSON(value)
}

func readLibraryJSON(path string, dst any) error {
	var reader io.Reader = os.Stdin
	if path != "-" {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		reader = file
	}
	raw, err := io.ReadAll(io.LimitReader(reader, (32<<20)+1))
	if err != nil {
		return err
	}
	if len(raw) > 32<<20 {
		return fmt.Errorf("JSON input exceeds 32 MiB")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(dst); err != nil {
		return err
	}
	if err = decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("expected exactly one JSON value")
	}
	return nil
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
	Limit             int    `default:"50" help:"Page size, 0-500."`
	Offset            int    `help:"Skip this many records."`
	JSON              bool   `help:"Accepted for symmetry; library output is always JSON."`
	MaxSensitivity    string `default:"normal" help:"Maximum Markdown sensitivity for index: normal, personal or confidential."`
	AllowConfidential bool   `help:"Explicitly publish confidential Markdown pages."`
	NoExtract         bool   `help:"Skip file text extraction after upload."`

	List             libraryListCmd             `cmd:"" help:"Items matching a query."`
	Activity         libraryListCmd             `cmd:"" help:"Activity matching a query."`
	Collections      libraryListCmd             `cmd:"" help:"Collections matching a query."`
	Files            libraryListCmd             `cmd:"" help:"Files matching a query."`
	Get              libraryGetCmd              `cmd:"" help:"Any record by id: item_, activity_, collection_, file_ or page_."`
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

func (l *libraryCmd) options() (library.ListOptions, error) {
	o := library.ListOptions{Match: l.Match, Source: l.Source, Account: l.Account, Kind: l.Kind, ItemID: l.ItemID, Since: l.Since, Until: l.Until, Limit: l.Limit, Offset: l.Offset}
	return o, o.Validate()
}

type libraryListCmd struct {
	Query []string `arg:"" optional:""`
}

func (c *libraryListCmd) Run(ctx context.Context, kctx *kong.Context, lib *libraryCmd) error {
	o, err := lib.options()
	if err != nil {
		return err
	}
	o.Query = strings.Join(c.Query, " ")
	b, closeBackend, err := openLibraryBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	switch kctx.Selected().Name {
	case "activity":
		return printLibrary(b.ListLibraryActivity(ctx, o))
	case "collections":
		return printLibrary(b.ListLibraryCollections(ctx, o))
	case "files":
		return printLibrary(b.ListLibraryFiles(ctx, o))
	default:
		return printLibrary(b.ListLibraryItems(ctx, o))
	}
}

type libraryGetCmd struct {
	ID string `arg:""`
}

func (c *libraryGetCmd) Run(ctx context.Context, kctx *kong.Context, lib *libraryCmd) error {
	if _, err := lib.options(); err != nil {
		return err
	}
	b, closeBackend, err := openLibraryBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	kind := kctx.Selected().Name
	if kind == "get" {
		kind, _, _ = strings.Cut(c.ID, "_")
	}
	switch kind {
	case "activity":
		return printLibrary(b.LibraryActivity(ctx, c.ID))
	case "collection":
		return printLibrary(b.LibraryCollection(ctx, c.ID))
	case "file":
		return printLibrary(b.LibraryFile(ctx, c.ID))
	case "page":
		return printLibrary(b.LibraryPage(ctx, c.ID))
	case "snapshots":
		return printLibrary(b.LibraryCollectionSnapshots(ctx, c.ID))
	}
	return printLibrary(b.LibraryItem(ctx, c.ID))
}

type libraryCreateCmd struct {
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryCreateCmd) Run(ctx context.Context, lib *libraryCmd) error {
	if _, err := lib.options(); err != nil {
		return err
	}
	var item library.Item
	if err := readLibraryJSON(c.Input, &item); err != nil {
		return err
	}
	if remote := client.FromEnv(); remote != nil {
		return printLibrary(remote.CreateLibraryItem(ctx, item))
	}
	item.Identity = library.Identity{Source: "manual", Account: "owner", ExternalID: rand.Text()}
	item.ID = library.StableID("item", item.Identity)
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		return err
	}
	return printLibrary(st.LibraryItem(ctx, item.ID))
}

type libraryCollectionCreateCmd struct {
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryCollectionCreateCmd) Run(ctx context.Context, lib *libraryCmd) error {
	if _, err := lib.options(); err != nil {
		return err
	}
	var value library.Collection
	if err := readLibraryJSON(c.Input, &value); err != nil {
		return err
	}
	value.Identity = library.Identity{Source: "manual", Account: "owner", ExternalID: rand.Text()}
	value.ID = library.StableID("collection", value.Identity)
	b, closeBackend, err := openLibraryBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	return printLibrary(b.CreateLibraryCollection(ctx, value))
}

type libraryStateCmd struct {
	ID    string `arg:""`
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryStateCmd) Run(ctx context.Context, lib *libraryCmd) error {
	if _, err := lib.options(); err != nil {
		return err
	}
	var edit library.StateEdit
	if err := readLibraryJSON(c.Input, &edit); err != nil {
		return err
	}
	if err := edit.Validate(); err != nil {
		return err
	}
	b, closeBackend, err := openLibraryBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	return printLibrary(b.SetLibraryState(ctx, c.ID, edit))
}

type libraryCollectionEditCmd struct {
	ID    string `arg:""`
	Input string `arg:"" help:"JSON file, or - for stdin."`
}

func (c *libraryCollectionEditCmd) Run(ctx context.Context, lib *libraryCmd) error {
	if _, err := lib.options(); err != nil {
		return err
	}
	var edit library.CollectionEdit
	if err := readLibraryJSON(c.Input, &edit); err != nil {
		return err
	}
	if err := edit.Validate(); err != nil {
		return err
	}
	b, closeBackend, err := openLibraryBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	return printLibrary(b.EditLibraryCollection(ctx, c.ID, edit))
}

type libraryUploadCmd struct {
	Paths []string `arg:"" name:"file"`
}

func (c *libraryUploadCmd) Run(ctx context.Context, lib *libraryCmd) error {
	o, err := lib.options()
	if err != nil {
		return err
	}
	return uploadLibrary(ctx, c.Paths, o, lib.NoExtract)
}

type libraryIndexCmd struct {
	Dir string `arg:"" name:"directory"`
}

func (c *libraryIndexCmd) Run(ctx context.Context, lib *libraryCmd) error {
	o, err := lib.options()
	if err != nil {
		return err
	}
	source := o.Source
	if source == "" {
		source = "brain"
	}
	opts := mediaimport.Options{Source: source, Account: o.Account, MaxSensitivity: lib.MaxSensitivity, AllowConfidential: lib.AllowConfidential}
	publication, err := mediaimport.BuildPublication(c.Dir, opts)
	if err != nil {
		return err
	}
	if remote := client.FromEnv(); remote != nil {
		return printLibrary(remote.PublishLibraryPages(ctx, publication))
	}
	local, closeLocal, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeLocal()
	return printLibrary(mediaimport.Publish(ctx, local.Store, local.ArchiveDir, publication))
}

func uploadLibrary(ctx context.Context, paths []string, o library.ListOptions, noExtract bool) error {
	if len(paths) == 0 || len(paths) > 100 {
		return fmt.Errorf("upload requires 1-100 files")
	}
	if o.Source == "" {
		o.Source = "files"
	}
	if o.Account == "" {
		o.Account = "owner"
	}
	if err := archive.ValidSource(o.Source); err != nil {
		return err
	}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("not a regular file: %s", path)
		}
	}
	if remote := client.FromEnv(); remote != nil {
		return printLibrary(remote.UploadLibraryFiles(ctx, paths, o.Source, o.Account, o.ItemID))
	}
	local, closeLocal, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeLocal()
	if o.ItemID != "" {
		if _, err = local.Store.LibraryItem(ctx, o.ItemID); err != nil {
			return err
		}
	}
	files := []library.File{}
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		digest, size, err := local.Blobs.Put(file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		value := library.File{Identity: library.Identity{Source: o.Source, Account: o.Account, ExternalID: digest + ":" + filepath.Base(path)}, SHA256: digest, Filename: filepath.Base(path), SizeBytes: size, MimeType: mime.TypeByExtension(filepath.Ext(path)), ItemIDs: []string{}}
		value.ID = library.StableID("file", value.Identity)
		if o.ItemID != "" {
			value.ItemIDs = []string{o.ItemID}
		}
		files = append(files, value)
	}
	if _, err = local.Store.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: files}); err != nil {
		return err
	}
	if err = extractAfterImport(ctx, blobtext.Local{Store: local.Store, Blobs: local.Blobs}, noExtract); err != nil {
		return err
	}
	for i := range files {
		files[i], err = local.Store.LibraryFile(ctx, files[i].ID)
		if err != nil {
			return err
		}
	}
	return printJSON(files)
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
		report("attachment", v.SHA256, v.Filename)
	}
	for _, n := range []int{len(result.Messages), len(result.Items), len(result.Activity), len(result.Collections), len(result.Files), len(result.Pages), len(result.Attachments)} {
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
