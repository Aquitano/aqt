package main

import (
	"context"
	"flag"
	"fmt"

	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

func cmdMediaImport(ctx context.Context, kind string, args []string) error {
	fs := flag.NewFlagSet("import "+kind, flag.ContinueOnError)
	source := fs.String("source", "", "source identity")
	account := fs.String("account", "", "profile or account identity; keep this stable across imports")
	dateOrder := fs.String("date-order", "", "Netflix slash-date order: mdy (default) or dmy")
	sensitivity := fs.String("max-sensitivity", "normal", "maximum Markdown sensitivity: normal or personal")
	confidential := fs.Bool("allow-confidential", false, "explicitly publish confidential Markdown pages")
	asJSON := fs.Bool("json", false, "print structured results")
	noExtract := fs.Bool("no-extract", false, "skip file text extraction")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
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
	for _, path := range fs.Args() {
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
