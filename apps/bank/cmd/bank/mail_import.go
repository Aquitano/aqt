package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

type importMailTreeCmd struct {
	Root      string `arg:""`
	Source    string `required:"" help:"Mail account source."`
	Layout    string `required:"" enum:"eml,thunderbird" help:"eml or thunderbird."`
	NoExtract bool   `help:"Skip attachment text extraction."`
}

// Run imports each mail file of the tree as its own raw input, with its
// folder as the input's mailbox.
func (c *importMailTreeCmd) Run(ctx context.Context) error {
	if err := ingest.ValidSource(c.Source); err != nil {
		return err
	}
	b, err := openImportBackend(ctx)
	if err != nil {
		return err
	}
	defer b.close()
	err = eml.WalkMailTree(filepath.Clean(c.Root), c.Layout, func(kind, path, mailbox string) error {
		var options any = eml.EMLOptions{Source: c.Source, Mailbox: mailbox}
		if kind == "mbox" {
			options = eml.MboxOptions{Source: c.Source, Mailbox: mailbox}
		}
		raw, err := json.Marshal(options)
		if err != nil {
			return err
		}
		return b.importPath(ctx, kind, path, raw)
	}, func(path, reason string) {
		fmt.Fprintf(os.Stderr, "bank: skip %s: %s\n", path, reason)
	})
	if err != nil {
		return err
	}
	return b.extract(ctx, c.NoExtract)
}
