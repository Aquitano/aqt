package main

import (
	"context"
	"fmt"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
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
	results := []any{}
	remote := client.FromEnv()
	var d *importer.Target
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
		var result any
		var err error
		switch {
		case kind == "markdown":
			var publication mediaimport.Publication
			if publication, err = mediaimport.BuildPublication(path, opts); err != nil {
				break
			}
			if remote != nil {
				result, err = remote.PublishLibraryPages(ctx, publication)
			} else {
				result, err = mediaimport.Publish(ctx, d.Store, d.ArchiveDir, publication)
			}
		case remote == nil:
			result, err = importer.Run(ctx, *d, kind, importer.Input{Path: path, Source: c.Source, Account: c.Account, DateOrder: c.DateOrder})
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
		if err := extractAfterImport(ctx, blobtext.Local{Store: d.Store, Blobs: d.Blobs}, c.NoExtract); err != nil {
			return err
		}
	}
	if c.JSON {
		return printJSON(results)
	}
	return nil
}
