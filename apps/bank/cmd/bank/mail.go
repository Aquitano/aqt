package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func cmdMail(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: bank mail rebuild|mailboxes|conflict --source <source> [flags]")
	}
	command := args[0]
	if command != "rebuild" && command != "mailboxes" && command != "conflict" {
		return fmt.Errorf("unknown mail command %q", command)
	}
	options := struct {
		CommandArguments
		Source string `name:"source"`
		JSON   bool   `name:"json"`
		Apply  bool   `name:"apply" help:"write projections (rebuild only)"`
		Before int64  `name:"before"`
		Limit  int    `name:"limit" default:"100"`
	}{}
	source := &options.Source
	asJSON := &options.JSON
	apply := &options.Apply
	before := &options.Before
	limit := &options.Limit
	if err := parseCommand("mail "+command, &options, args[1:]); err != nil {
		return err
	}

	if err := archive.ValidSource(*source); err != nil {
		return err
	}
	if command == "rebuild" {
		if len(options.Args) != 0 {
			return fmt.Errorf("rebuild takes no positional arguments")
		}
		if client.FromEnv() != nil {
			return fmt.Errorf("mail rebuild is owner-local; unset BANK_URL and run beside the archive database")
		}
		var database *store.Store
		var err error
		if *apply {
			database, err = openStore(ctx)
		} else {
			connection := os.Getenv("DATABASE_URL")
			if connection == "" {
				connection = "postgres://bank:bank@localhost:5433/bank?sslmode=disable"
			}
			database, err = store.OpenReadOnly(ctx, connection)
		}
		if err != nil {
			return err
		}
		defer database.Close()
		report, err := eml.RebuildMail(ctx, database, filepath.Join(dataDir(), "archive"), *source, *apply)
		return errors.Join(err, printJSON(report))
	}
	if *apply {
		return fmt.Errorf("--apply is only valid for rebuild")
	}
	backend, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	if command == "mailboxes" {
		if len(options.Args) != 0 {
			return fmt.Errorf("mailboxes takes no positional arguments")
		}
		mailboxes, err := backend.ListMailboxes(ctx, *source)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(mailboxes)
		}
		for _, mailbox := range mailboxes {
			fmt.Printf("%6d  %-6s  %6d  %s\n", mailbox.ID, mailbox.Kind, mailbox.Count, mailbox.Path)
		}
		return nil
	}
	if len(options.Args) != 1 || *before < 0 || *limit < 1 || *limit > store.MaxThreadMessages {
		return fmt.Errorf("usage: bank mail conflict <key> --source <source> [--before id] [--limit n]")
	}
	page, err := backend.MailConflictMessages(ctx, *source, commandArg(options.Args, 0), *before, *limit)
	if err != nil {
		return err
	}
	return printJSON(page)
}
