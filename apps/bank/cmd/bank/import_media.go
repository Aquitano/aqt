package main

import (
	"context"
	"fmt"

	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

func cmdMediaImport(ctx context.Context, kind string, args []string) error {
	options := struct {
		CommandArguments
		Source            string `name:"source" help:"source identity"`
		Account           string `name:"account" help:"profile or account identity; keep this stable across imports"`
		DateOrder         string `name:"date-order" help:"Netflix slash-date order: mdy (default) or dmy"`
		MaxSensitivity    string `name:"max-sensitivity" default:"normal" help:"maximum Markdown sensitivity: normal or personal"`
		AllowConfidential bool   `name:"allow-confidential" help:"explicitly publish confidential Markdown pages"`
		JSON              bool   `name:"json" help:"print structured results"`
		NoExtract         bool   `name:"no-extract" help:"skip file text extraction"`
	}{}
	source := &options.Source
	account := &options.Account
	dateOrder := &options.DateOrder
	sensitivity := &options.MaxSensitivity
	confidential := &options.AllowConfidential
	asJSON := &options.JSON
	noExtract := &options.NoExtract
	if err := parseCommand("import "+kind, &options, args); err != nil {
		return err
	}

	if len(options.Args) == 0 {
		return fmt.Errorf("usage: bank import %s <path>... [--account NAME] [--json]", kind)
	}
	if *dateOrder != "" && (kind != "netflix" || (*dateOrder != "mdy" && *dateOrder != "dmy")) {
		return fmt.Errorf("--date-order requires netflix and must be mdy or dmy")
	}
	opts := mediaimport.Options{Source: *source, Account: *account, NetflixDateOrder: *dateOrder, MaxSensitivity: *sensitivity, AllowConfidential: *confidential}
	results := []mediaimport.Result{}
	remote := client.FromEnv()
	var d *local
	if remote == nil {
		var closeStore func()
		var err error
		d, closeStore, err = openLocal(ctx)
		if err != nil {
			return err
		}
		defer closeStore()
	}
	for _, path := range options.Args {
		var result mediaimport.Result
		var err error
		switch {
		case remote == nil:
			result, err = mediaimport.Import(ctx, d.st, d.blobs, d.archiveDir, kind, path, opts)
		case kind == "markdown":
			var publication mediaimport.Publication
			publication, err = mediaimport.BuildPublication(path, opts)
			if err == nil {
				result, err = remote.PublishLibraryPages(ctx, publication)
			}
		default:
			result, err = remote.ImportMediaFile(ctx, kind, *source, *account, path, *dateOrder)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		results = append(results, result)
		if !*asJSON {
			printImportResult(kind, *source, path, result)
		}
	}
	if d != nil {
		if err := extractAfterImport(ctx, blobtext.Local{Store: d.st, Blobs: d.blobs}, *noExtract); err != nil {
			return err
		}
	}
	if *asJSON {
		return printJSON(results)
	}
	return nil
}
