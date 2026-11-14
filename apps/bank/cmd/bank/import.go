package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// importCmd holds one subcommand per registered kind, built from the kind's
// options, beside the two commands that are not a single kind.
type importCmd struct {
	Kinds    kong.Plugins      `embed:""`
	MailTree importMailTreeCmd `cmd:"" name:"mail-tree" help:"A folder tree of mail, preserving each folder."`
	Inbox    importInboxCmd    `cmd:"" help:"Sweep $BANK_DATA_DIR/inbox/<kind>/."`
}

// importPath imports one file or directory and prints what it did.
func importPath(ctx context.Context, api *client.Client, kind, path string, options json.RawMessage) error {
	name, r, err := importer.Open(path)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := importReader(ctx, api, kind, name, r, options); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func importReader(ctx context.Context, api *client.Client, kind, name string, r io.Reader, options json.RawMessage) error {
	k, err := sources.All.Lookup(kind)
	if err != nil {
		return err
	}
	raw, err := client.Upload(ctx, api, server.ImportOp(k), server.ImportInput{}, client.ImportFile(name, r, options))
	if err != nil {
		return err
	}
	printRawInput(raw)
	return nil
}

// runImport checks the options before anything is sent, so a mistyped flag
// does not cost the upload of a whole export.
func runImport(ctx context.Context, kind string, paths []string, options json.RawMessage) error {
	k, err := sources.All.Lookup(kind)
	if err != nil {
		return err
	}
	if options, err = k.Normalize(options); err != nil {
		return err
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	for _, path := range paths {
		if err := importPath(ctx, api, kind, path, options); err != nil {
			return err
		}
	}
	return nil
}

// printRawInput says what one import did: one line on stdout, and the
// reported issues on stderr.
func printRawInput(r store.RawInput) {
	rep := r.Report
	line := fmt.Sprintf("%s (%s): %d new, %d already known", r.Kind, r.Name, rep.Inserted, rep.Duplicates)
	if rep.Retired > 0 {
		line += fmt.Sprintf(", %d retired", rep.Retired)
	}
	if rep.Attachments > 0 {
		line += fmt.Sprintf(", %d attachments", rep.Attachments)
	}
	if l := rep.Library; l != (library.ImportResult{}) {
		line += fmt.Sprintf(", library: %d items, %d activity, %d collections, %d files, %d pages, %d already known",
			l.Items, l.Activity, l.Collections, l.Files, l.Pages, l.Duplicates)
	}
	for _, kind := range slices.Sorted(maps.Keys(rep.Issues)) {
		line += fmt.Sprintf(", %d %s", rep.Issues[kind], strings.ReplaceAll(string(kind), "_", " "))
	}
	fmt.Printf("%s [raw input %d, %s]\n", line, r.ID, r.Status)
	for _, issue := range rep.Details {
		fmt.Fprintf(os.Stderr, "bank: %s: %s\n", issue.Kind, issue.Detail)
	}
}

type importInboxCmd struct {
	JSON bool `help:"JSON output."`
}

func (c *importInboxCmd) Run(ctx context.Context) error {
	if err := onTheBox("import inbox", "reads the server's own drop zone"); err != nil {
		return err
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	inboxDir := filepath.Join(dataDir(), "inbox")
	res, sweepErr := importer.SweepInbox(ctx, *d, inboxDir)
	if c.JSON {
		if err := printJSON(res); err != nil {
			return err
		}
		return sweepErr
	}
	for _, warning := range res.Warnings {
		fmt.Fprintf(os.Stderr, "bank: %s\n", warning)
	}
	if len(res.Files) == 0 {
		fmt.Printf("inbox is empty (%s/<%s>/)\n", inboxDir, strings.Join(d.Kinds.Names(), "|"))
		return sweepErr
	}
	for _, f := range res.Files {
		fmt.Printf("%-13s %-9s %s", f.Kind, f.Disposition, filepath.Base(f.Path))
		if f.Detail != "" {
			fmt.Printf("  (%s)", f.Detail)
		}
		fmt.Println()
	}
	fmt.Printf("%d imported, %d already known, %d rejected, %d failed\n",
		res.Imported, res.Duplicates, res.Rejected, res.Failed)
	if res.Settling > 0 {
		fmt.Printf("%d entr(ies) modified moments ago were left for the next sweep\n", res.Settling)
	}
	return sweepErr
}

// reimportCmd replays stored raw inputs through today's sources. Imports are
// idempotent, so the only visible effect is whatever today's source does
// better than the one that first read the input.
type reimportCmd struct {
	Kinds []string `arg:"" optional:"" name:"kind" help:"Kinds to replay; every kind when none is given."`
	JSON  bool     `help:"JSON output."`
}

func (c *reimportCmd) Run(ctx context.Context) error {
	if err := onTheBox("reimport", "replays the server's own raw inputs"); err != nil {
		return err
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	type replayed struct {
		store.RawInput
		Problem string `json:"problem,omitempty"`
	}
	out := []replayed{}
	failed := 0
	err = importer.Replay(ctx, *d, c.Kinds, func(raw store.RawInput, err error) {
		r := replayed{RawInput: raw}
		if err != nil {
			failed++
			r.Problem = err.Error()
			fmt.Fprintf(os.Stderr, "bank: raw input %d (%s): %v\n", raw.ID, raw.Name, err)
		} else if !c.JSON {
			printRawInput(raw)
		}
		out = append(out, r)
	})
	if err != nil {
		return err
	}
	if c.JSON {
		if err := printJSON(out); err != nil {
			return err
		}
	} else if len(out) == 0 {
		fmt.Println("no raw inputs to replay")
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d raw inputs failed to replay", failed, len(out))
	}
	return nil
}
