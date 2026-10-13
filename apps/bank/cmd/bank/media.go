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

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

const libraryUsage = `bank library list|activity|collections|files [query] [--source s] [--kind k] [--limit n]
bank library get|collection|file|page|snapshots <id>
bank library create|collection-create <json-file|->
bank library state|collection-edit <id> <json-file|->
bank library upload <file>... [--source files] [--account owner] [--item-id id]
bank library index <directory> [--source brain] [--account name] [--max-sensitivity normal|personal|confidential] [--allow-confidential]
All library commands return JSON. Edits require expected_revision from the latest detail.`

type libraryBackend interface {
	ListLibraryItems(context.Context, library.ListOptions) ([]library.Item, error)
	ListLibraryActivity(context.Context, library.ListOptions) ([]library.Activity, error)
	ListLibraryCollections(context.Context, library.ListOptions) ([]library.Collection, error)
	ListLibraryFiles(context.Context, library.ListOptions) ([]library.File, error)
	LibraryItem(context.Context, string) (library.Item, error)
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

func cmdLibrary(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(libraryUsage)
	}
	action := args[0]
	if action == "help" || action == "--help" {
		fmt.Println(libraryUsage)
		return nil
	}
	options := struct {
		CommandArguments
		Match             string `name:"match" default:"any"`
		Source            string `name:"source"`
		Account           string `name:"account"`
		Kind              string `name:"kind"`
		ItemID            string `name:"item-id"`
		Since             string `name:"since"`
		Until             string `name:"until"`
		Limit             int    `name:"limit" default:"50"`
		Offset            int    `name:"offset"`
		JSON              bool   `name:"json"`
		MaxSensitivity    string `name:"max-sensitivity" default:"normal"`
		AllowConfidential bool   `name:"allow-confidential"`
		NoExtract         bool   `name:"no-extract"`
	}{}
	o := library.ListOptions{}
	maxSensitivity := &options.MaxSensitivity
	allowConfidential := &options.AllowConfidential
	noExtract := &options.NoExtract
	if err := parseCommand("library "+action, &options, args[1:]); err != nil {
		return err
	}
	o.Match = options.Match
	o.Source = options.Source
	o.Account = options.Account
	o.Kind = options.Kind
	o.ItemID = options.ItemID
	o.Since = options.Since
	o.Until = options.Until
	o.Limit = options.Limit
	o.Offset = options.Offset

	if err := o.Validate(); err != nil {
		return err
	}
	args = options.Args
	if action == "upload" {
		return uploadLibrary(ctx, args, o, *noExtract)
	}
	if action == "index" {
		if len(args) != 1 {
			return errors.New(libraryUsage)
		}
		source := o.Source
		if source == "" {
			source = "brain"
		}
		opts := mediaimport.Options{Source: source, Account: o.Account, MaxSensitivity: *maxSensitivity, AllowConfidential: *allowConfidential}
		publication, err := mediaimport.BuildPublication(args[0], opts)
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
		return printLibrary(mediaimport.Publish(ctx, local.st, local.archiveDir, publication))
	}
	if action == "create" {
		if len(args) != 1 {
			return errors.New(libraryUsage)
		}
		var item library.Item
		if err := readLibraryJSON(args[0], &item); err != nil {
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
	b, closeBackend, err := openLibraryBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	switch action {
	case "list":
		o.Query = strings.Join(args, " ")
		return printLibrary(b.ListLibraryItems(ctx, o))
	case "activity":
		o.Query = strings.Join(args, " ")
		return printLibrary(b.ListLibraryActivity(ctx, o))
	case "collections":
		o.Query = strings.Join(args, " ")
		return printLibrary(b.ListLibraryCollections(ctx, o))
	case "files":
		o.Query = strings.Join(args, " ")
		return printLibrary(b.ListLibraryFiles(ctx, o))
	case "get", "collection", "file", "page", "snapshots":
		if len(args) != 1 {
			return errors.New(libraryUsage)
		}
		switch action {
		case "get":
			return printLibrary(b.LibraryItem(ctx, args[0]))
		case "collection":
			return printLibrary(b.LibraryCollection(ctx, args[0]))
		case "file":
			return printLibrary(b.LibraryFile(ctx, args[0]))
		case "page":
			return printLibrary(b.LibraryPage(ctx, args[0]))
		default:
			return printLibrary(b.LibraryCollectionSnapshots(ctx, args[0]))
		}
	case "state":
		if len(args) != 2 {
			return errors.New(libraryUsage)
		}
		var edit library.StateEdit
		if err := readLibraryJSON(args[1], &edit); err != nil {
			return err
		}
		if err := edit.Validate(); err != nil {
			return err
		}
		return printLibrary(b.SetLibraryState(ctx, args[0], edit))
	case "collection-create":
		if len(args) != 1 {
			return errors.New(libraryUsage)
		}
		var value library.Collection
		if err := readLibraryJSON(args[0], &value); err != nil {
			return err
		}
		value.Identity = library.Identity{Source: "manual", Account: "owner", ExternalID: rand.Text()}
		value.ID = library.StableID("collection", value.Identity)
		return printLibrary(b.CreateLibraryCollection(ctx, value))
	case "collection-edit":
		if len(args) != 2 {
			return errors.New(libraryUsage)
		}
		var edit library.CollectionEdit
		if err := readLibraryJSON(args[1], &edit); err != nil {
			return err
		}
		if err := edit.Validate(); err != nil {
			return err
		}
		return printLibrary(b.EditLibraryCollection(ctx, args[0], edit))
	default:
		return errors.New(libraryUsage)
	}
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
		if _, err = local.st.LibraryItem(ctx, o.ItemID); err != nil {
			return err
		}
	}
	files := []library.File{}
	for _, path := range paths {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		digest, size, err := local.blobs.Put(file)
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
	if _, err = local.st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: files}); err != nil {
		return err
	}
	if err = extractAfterImport(ctx, blobtext.Local{Store: local.st, Blobs: local.blobs}, noExtract); err != nil {
		return err
	}
	for i := range files {
		files[i], err = local.st.LibraryFile(ctx, files[i].ID)
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
