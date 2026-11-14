package main

import (
	"context"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type reportsCmd struct {
	Before int64 `help:"Page backward from this raw input id."`
	Limit  int   `default:"${limit}" help:"Page size, 1-${max_limit}."`
	JSON   bool  `help:"JSON output."`
}

func (c *reportsCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	inputs, err := client.Call(ctx, api, server.ListRawInputs, server.RawInputsInput{Before: c.Before, PageSize: httpapi.PageSize{Limit: c.Limit}})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(inputs)
	}
	for _, r := range inputs {
		fmt.Printf("#%d %s ", r.ID, r.ReceivedAt.Format(time.RFC3339))
		printRawInput(r)
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
	Offset   int    `help:"Skip this many files, at most ${max_offset}."`
	Limit    int    `default:"${limit}" help:"Page size, 1-${max_limit}."`
	JSON     bool   `help:"JSON output."`
}

func (c *attachmentFindCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	files, err := client.Call(ctx, api, server.SearchAttachments, server.SearchAttachmentsInput{Q: c.Filename, Text: c.Text, Type: c.Type,
		Person: c.Person, Since: c.Since, Until: c.Until, Page: pageOf(c.Limit, c.Offset)})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(files)
	}
	for _, f := range files {
		fmt.Printf("%s  %s  %s  %d messages\n", f.BLAKE3, f.Filename, humanSize(f.SizeBytes), f.Messages)
	}
	return nil
}

type attachmentMessagesCmd struct {
	BLAKE3 content.Digest `arg:"" name:"blake3" help:"The content's BLAKE3 digest, 64 lowercase hex characters."`
	Offset int            `help:"Skip this many messages, at most ${max_offset}."`
	Limit  int            `default:"${limit}" help:"Page size, 1-${max_limit}."`
}

func (c *attachmentMessagesCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	messages, err := client.Call(ctx, api, server.ListAttachmentMessages, server.AttachmentMessagesInput{BLAKE3: c.BLAKE3, Page: pageOf(c.Limit, c.Offset)})
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
