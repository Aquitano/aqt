package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources/eml"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type mailCmd struct {
	Source    string           `help:"Mail source (gmail, proton, ...)."`
	JSON      bool             `help:"JSON output (rebuild and conflict always print JSON)."`
	Rebuild   mailRebuildCmd   `cmd:"" help:"Rebuild mail metadata (dry run by default)."`
	Mailboxes mailMailboxesCmd `cmd:"" help:"List historically observed folders."`
	Conflict  mailConflictCmd  `cmd:"" help:"Page unanchored mail after a thread split."`
}

type mailRebuildCmd struct {
	Apply bool `help:"Write projections."`
}

func (c *mailRebuildCmd) Run(ctx context.Context, mail *mailCmd) error {
	if err := onTheBox("mail rebuild", "rewrites the server's own mail metadata from its blobs"); err != nil {
		return err
	}
	if err := ingest.ValidSource(mail.Source); err != nil {
		return err
	}
	open := db.OpenReadOnly
	if c.Apply {
		open = db.Open
	}
	pool, err := open(ctx, databaseURL())
	if err != nil {
		return err
	}
	defer pool.Close()
	blobs, err := blob.New(filepath.Join(dataDir(), "blobs"))
	if err != nil {
		return err
	}
	report, err := eml.RebuildMail(ctx, store.New(pool), blobs, mail.Source, c.Apply)
	return errors.Join(err, printJSON(report))
}

type mailMailboxesCmd struct{}

func (mailMailboxesCmd) Run(ctx context.Context, mail *mailCmd) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	mailboxes, err := client.Call(ctx, api, server.ListMailboxes, server.MailboxesInput{Source: mail.Source})
	if err != nil {
		return err
	}
	if mail.JSON {
		return printJSON(mailboxes)
	}
	for _, mailbox := range mailboxes {
		fmt.Printf("%6d  %-6s  %6d  %s\n", mailbox.ID, mailbox.Kind, mailbox.Count, mailbox.Path)
	}
	return nil
}

type mailConflictCmd struct {
	Key    string      `arg:""`
	Before ref.Message `help:"Page backward from this message, by ref."`
	Limit  int         `default:"${limit}" help:"Page size, 1-${max_limit}."`
}

func (c *mailConflictCmd) Run(ctx context.Context, mail *mailCmd) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	messages, err := client.Call(ctx, api, server.GetMailConflict, server.MailConflictInput{Key: c.Key, Source: mail.Source,
		Before: c.Before, PageSize: httpapi.PageSize{Limit: c.Limit}})
	if err != nil {
		return err
	}
	return printJSON(messages)
}
