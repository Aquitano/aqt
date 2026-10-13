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

func cmdImportMailTree(ctx context.Context, args []string) error {
	options := struct {
		CommandArguments
		Source    string `name:"source" help:"mail account source"`
		Layout    string `name:"layout" help:"eml or thunderbird"`
		NoExtract bool   `name:"no-extract" help:"skip attachment text extraction"`
	}{}
	source := &options.Source
	layout := &options.Layout
	noExtract := &options.NoExtract
	if err := parseCommand("import mail-tree", &options, args); err != nil {
		return err
	}

	if len(options.Args) != 1 || (*layout != "eml" && *layout != "thunderbird") {
		return fmt.Errorf("usage: bank import mail-tree --source <source> --layout eml|thunderbird <root>")
	}
	if err := archive.ValidSource(*source); err != nil {
		return err
	}
	return withMailImporter(ctx, *source, *noExtract, func(importFile func(string, string, eml.MailImportContext) error) error {
		return eml.WalkMailTree(filepath.Clean(commandArg(options.Args, 0)), *layout, importFile, func(path, reason string) {
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
