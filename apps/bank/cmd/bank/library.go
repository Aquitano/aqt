package main

import (
	"context"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func cmdReports(ctx context.Context, args []string) error {
	options := struct {
		CommandArguments
		Before int64 `name:"before"`
		Limit  int   `name:"limit" default:"50"`
		JSON   bool  `name:"json"`
	}{}
	before := &options.Before
	limit := &options.Limit
	asJSON := &options.JSON
	if err := parseCommand("reports", &options, args); err != nil {
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
	options := struct {
		CommandArguments
		Filename string `name:"filename"`
		Text     string `name:"text"`
		Type     string `name:"type"`
		Person   string `name:"person"`
		Since    string `name:"since"`
		Until    string `name:"until"`
		Offset   int    `name:"offset"`
		Limit    int    `name:"limit" default:"50"`
		JSON     bool   `name:"json"`
	}{}
	var o store.AttachmentFilter
	since := &options.Since
	until := &options.Until
	asJSON := &options.JSON
	if err := parseCommand("attachment find", &options, args); err != nil {
		return err
	}
	o.Filename = options.Filename
	o.Text = options.Text
	o.FileType = options.Type
	o.Person = options.Person
	o.Offset = options.Offset
	o.Limit = options.Limit

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
	options := struct {
		CommandArguments
		Offset int `name:"offset"`
		Limit  int `name:"limit" default:"50"`
	}{}
	offset := &options.Offset
	limit := &options.Limit
	if err := parseCommand("attachment messages", &options, args); err != nil {
		return err
	}

	if len(options.Args) != 1 {
		return fmt.Errorf("usage: bank attachment messages <sha256> [--offset N] [--limit N]")
	}
	if err := blob.ValidDigest(commandArg(options.Args, 0)); err != nil {
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
	messages, err := b.AttachmentMessages(ctx, commandArg(options.Args, 0), *offset, *limit)
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
