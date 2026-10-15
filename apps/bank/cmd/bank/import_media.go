package main

import (
	"context"
	"fmt"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

type importMediaCmd struct {
	Paths             []string `arg:"" name:"path"`
	Source            string   `help:"Source identity."`
	Account           string   `help:"Profile or account identity; keep this stable across imports."`
	DateOrder         string   `help:"Netflix slash-date order: mdy (default) or dmy."`
	MaxSensitivity    string   `default:"normal" help:"Maximum Markdown sensitivity: normal or personal."`
	AllowConfidential bool     `help:"Explicitly publish confidential Markdown pages."`
	JSON              bool     `help:"Print structured results."`
	NoExtract         bool     `help:"Skip file text extraction."`
}

func (c *importMediaCmd) Run(ctx context.Context, kctx *kong.Context) error {
	kind := kctx.Selected().Name
	if c.DateOrder != "" && (kind != "netflix" || (c.DateOrder != "mdy" && c.DateOrder != "dmy")) {
		return fmt.Errorf("--date-order requires netflix and must be mdy or dmy")
	}
	opts := mediaimport.Options{Source: c.Source, Account: c.Account, NetflixDateOrder: c.DateOrder, MaxSensitivity: c.MaxSensitivity, AllowConfidential: c.AllowConfidential}
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
	for _, path := range c.Paths {
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
			result, err = remote.ImportMediaFile(ctx, kind, c.Source, c.Account, path, c.DateOrder)
		}
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		results = append(results, result)
		if !c.JSON {
			printImportResult(kind, c.Source, path, result)
		}
	}
	if d != nil {
		if err := extractAfterImport(ctx, blobtext.Local{Store: d.st, Blobs: d.blobs}, c.NoExtract); err != nil {
			return err
		}
	}
	if c.JSON {
		return printJSON(results)
	}
	return nil
}
