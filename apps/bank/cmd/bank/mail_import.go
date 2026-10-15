package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
)

type importMailTreeCmd struct {
	Root      string `arg:""`
	Source    string `required:"" help:"Mail account source."`
	Layout    string `required:"" enum:"eml,thunderbird" help:"eml or thunderbird."`
	NoExtract bool   `help:"Skip attachment text extraction."`
}

func (c *importMailTreeCmd) Run(ctx context.Context) error {
	if err := archive.ValidSource(c.Source); err != nil {
		return err
	}
	return withMailImporter(ctx, c.Source, c.NoExtract, func(importFile func(string, string, eml.MailImportContext) error) error {
		return eml.WalkMailTree(filepath.Clean(c.Root), c.Layout, importFile, func(path, reason string) {
			fmt.Fprintf(os.Stderr, "bank: skip %s: %s\n", path, reason)
		})
	})
}

func importMailboxFiles(ctx context.Context, kind, source, mailbox string, paths []string, noExtract bool) error {
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("--mailbox takes regular files; use mail-tree for directories")
		}
		if err := (eml.MailImportContext{Version: 1, Kind: "export", Mailbox: mailbox, RelativePath: filepath.Base(path)}).Validate(); err != nil {
			return err
		}
	}
	return withMailImporter(ctx, source, noExtract, func(importFile func(string, string, eml.MailImportContext) error) error {
		for _, path := range paths {
			if err := importFile(kind, path, eml.MailImportContext{Version: 1, Kind: "export", Mailbox: mailbox, RelativePath: filepath.Base(path)}); err != nil {
				return err
			}
		}
		return nil
	})
}

func withMailImporter(ctx context.Context, source string, noExtract bool, run func(func(string, string, eml.MailImportContext) error) error) error {
	if remote := client.FromEnv(); remote != nil {
		return run(func(kind, path string, observation eml.MailImportContext) error {
			result, err := client.ImportFile[eml.Result](ctx, remote, kind, source, path, &observation)
			if err == nil {
				printEmlResult(source, path, result)
			}
			return err
		})
	}
	local, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	err = run(func(kind, path string, observation eml.MailImportContext) error {
		var result eml.Result
		var err error
		if kind == "eml" {
			result, err = eml.ImportEmlPath(ctx, local.st, local.blobs, local.archiveDir, source, path, &observation)
		} else {
			result, err = eml.ImportMbox(ctx, local.st, local.blobs, local.archiveDir, source, path, &observation)
		}
		if err == nil {
			printEmlResult(source, path, result)
		}
		return err
	})
	if err != nil {
		return err
	}
	return extractAfterImport(ctx, blobtext.Local{Store: local.st, Blobs: local.blobs}, noExtract)
}
