package main

import (
	"context"
	"flag"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func cmdReports(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("reports", flag.ContinueOnError)
	before := fs.Int64("before", 0, "")
	limit := fs.Int("limit", 50, "")
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *before < 0 || *limit < 1 || *limit > 100 {
		return fmt.Errorf("before must be nonnegative and limit must be 1-100")
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	reports, err := b.ImportReports(ctx, *before, *limit)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(reports)
	}
	for _, r := range reports {
		fmt.Printf("#%d %s %s %s\n  %s\n  %s\n", r.ID, r.StartedAt.Format(time.RFC3339), r.Kind, r.Status, r.Input, r.Result)
		if r.Error != "" {
			fmt.Printf("  %s\n", r.Error)
		}
	}
	return nil
}

func cmdAttachmentFind(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("attachment find", flag.ContinueOnError)
	var o store.AttachmentFilter
	fs.StringVar(&o.Filename, "filename", "", "")
	fs.StringVar(&o.Text, "text", "", "")
	fs.StringVar(&o.FileType, "type", "", "")
	fs.StringVar(&o.Person, "person", "", "")
	since := fs.String("since", "", "")
	until := fs.String("until", "", "")
	fs.IntVar(&o.Offset, "offset", 0, "")
	fs.IntVar(&o.Limit, "limit", 50, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if o.Offset < 0 || o.Offset > store.MaxSearchOffset || o.Limit < 1 || o.Limit > 100 {
		return fmt.Errorf("invalid pagination")
	}
	var err error
	if *since != "" {
		o.Since, err = time.Parse("2006-01-02", *since)
		if err != nil {
			return err
		}
	}
	if *until != "" {
		o.Until, err = time.Parse("2006-01-02", *until)
		if err != nil {
			return err
		}
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	files, err := b.AttachmentLibrary(ctx, o)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(files)
	}
	for _, f := range files {
		fmt.Printf("%s  %s  %s  %d messages\n", f.SHA256, f.Filename, humanBytes(f.SizeBytes), f.Messages)
	}
	return nil
}

func cmdAttachmentMessages(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("attachment messages", flag.ContinueOnError)
	offset := fs.Int("offset", 0, "")
	limit := fs.Int("limit", 50, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: bank attachment messages <sha256> [--offset N] [--limit N]")
	}
	if err := blob.ValidDigest(fs.Arg(0)); err != nil {
		return err
	}
	if *offset < 0 || *offset > store.MaxSearchOffset || *limit < 1 || *limit > 100 {
		return fmt.Errorf("invalid pagination")
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	messages, err := b.AttachmentMessages(ctx, fs.Arg(0), *offset, *limit)
	if err != nil {
		return err
	}
	return printJSON(messages)
}

func printReplyInfo(m store.Message) {
	if m.ParentExternalID != "" {
		fmt.Printf("reply to: %s\n", m.ParentExternalID)
	}
	if m.BranchID != "" {
		fmt.Printf("branch: %s\n", m.BranchID)
	}
	if m.AlternativeIndex > 0 {
		fmt.Printf("alternative answer: %d\n", m.AlternativeIndex)
	}
}
