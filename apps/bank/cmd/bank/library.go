package main

import (
	"context"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type reportsCmd struct {
	Before int64 `help:"Page backward from this report id."`
	Limit  int   `default:"50" help:"Page size, 1-100."`
	JSON   bool  `help:"JSON output."`
}

func (c *reportsCmd) Run(ctx context.Context) error {
	if c.Before < 0 || c.Limit < 1 || c.Limit > 100 {
		return fmt.Errorf("before must be nonnegative and limit must be 1-100")
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	reports, err := b.ImportReports(ctx, c.Before, c.Limit)
	if err != nil {
		return err
	}
	if c.JSON {
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

type attachmentFindCmd struct {
	Filename string `help:"Filename contains this."`
	Text     string `help:"Extracted text contains this phrase."`
	Type     string `help:"Extension, MIME type or category such as image."`
	Person   string `help:"Contact name."`
	Since    string `help:"YYYY-MM-DD."`
	Until    string `help:"YYYY-MM-DD (exclusive)."`
	Offset   int    `help:"Skip this many files."`
	Limit    int    `default:"50" help:"Page size, 1-100."`
	JSON     bool   `help:"JSON output."`
}

func (c *attachmentFindCmd) Run(ctx context.Context) error {
	o := store.AttachmentFilter{Filename: c.Filename, Text: c.Text, FileType: c.Type, Person: c.Person, Offset: c.Offset, Limit: c.Limit}
	if o.Offset < 0 || o.Offset > store.MaxSearchOffset || o.Limit < 1 || o.Limit > 100 {
		return fmt.Errorf("invalid pagination")
	}
	var err error
	if c.Since != "" {
		o.Since, err = time.Parse("2006-01-02", c.Since)
		if err != nil {
			return err
		}
	}
	if c.Until != "" {
		o.Until, err = time.Parse("2006-01-02", c.Until)
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
	if c.JSON {
		return printJSON(files)
	}
	for _, f := range files {
		fmt.Printf("%s  %s  %s  %d messages\n", f.SHA256, f.Filename, humanBytes(f.SizeBytes), f.Messages)
	}
	return nil
}

type attachmentMessagesCmd struct {
	SHA256 string `arg:"" name:"sha256"`
	Offset int    `help:"Skip this many messages."`
	Limit  int    `default:"50" help:"Page size, 1-100."`
}

func (c *attachmentMessagesCmd) Run(ctx context.Context) error {
	if err := blob.ValidDigest(c.SHA256); err != nil {
		return err
	}
	if c.Offset < 0 || c.Offset > store.MaxSearchOffset || c.Limit < 1 || c.Limit > 100 {
		return fmt.Errorf("invalid pagination")
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	messages, err := b.AttachmentMessages(ctx, c.SHA256, c.Offset, c.Limit)
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
