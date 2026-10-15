package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
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
	if err := archive.ValidSource(mail.Source); err != nil {
		return err
	}
	if client.FromEnv() != nil {
		return fmt.Errorf("mail rebuild is owner-local; unset BANK_URL and run beside the archive database")
	}
	var database *store.Store
	var err error
	if c.Apply {
		database, err = openStore(ctx)
	} else {
		database, err = store.OpenReadOnly(ctx, databaseURL())
	}
	if err != nil {
		return err
	}
	defer database.Close()
	report, err := eml.RebuildMail(ctx, database, filepath.Join(dataDir(), "archive"), mail.Source, c.Apply)
	return errors.Join(err, printJSON(report))
}

type mailMailboxesCmd struct{}

func (mailMailboxesCmd) Run(ctx context.Context, mail *mailCmd) error {
	if err := archive.ValidSource(mail.Source); err != nil {
		return err
	}
	backend, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	mailboxes, err := backend.ListMailboxes(ctx, mail.Source)
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
	Key    string `arg:""`
	Before int64  `help:"Page backward from this message."`
	Limit  int    `default:"100" help:"Page size."`
}

func (c *mailConflictCmd) Run(ctx context.Context, mail *mailCmd) error {
	if err := archive.ValidSource(mail.Source); err != nil {
		return err
	}
	if c.Before < 0 || c.Limit < 1 || c.Limit > store.MaxThreadMessages {
		return fmt.Errorf("usage: bank mail conflict <key> --source <source> [--before id] [--limit n]")
	}
	backend, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	page, err := backend.MailConflictMessages(ctx, mail.Source, c.Key, c.Before, c.Limit)
	if err != nil {
		return err
	}
	return printJSON(page)
}
