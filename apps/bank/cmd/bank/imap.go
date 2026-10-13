package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"syscall"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/imapsync"
)

func cmdIMAP(ctx context.Context, args []string) error {
	options := struct {
		CommandArguments
		Config string `name:"config" help:"JSON account configuration"`
		Once   bool   `name:"once" help:"sync once and exit"`
		Check  bool   `name:"check" help:"authenticate and list folders without importing"`
		Status bool   `name:"status" help:"read local sync status without connecting"`
	}{}
	configPath := &options.Config
	once := &options.Once
	check := &options.Check
	status := &options.Status
	if err := parseCommand("imap", &options, args); err != nil {
		return err
	}

	if *configPath == "" || len(options.Args) != 0 || (*once && (*check || *status)) || (*check && *status) {
		return fmt.Errorf("usage: bank imap --config <file> [--once | --check | --status]")
	}
	config, err := imapsync.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	if *status {
		statuses, err := imapsync.ReadStatus(config.StateDir)
		if err != nil {
			return err
		}
		return encoder.Encode(statuses)
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *check {
		mailboxes, err := imapsync.Check(ctx, config)
		return errors.Join(err, encoder.Encode(mailboxes))
	}
	destination := os.Getenv("BANK_URL")
	parsed, err := url.Parse(destination)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || os.Getenv("BANK_TOKEN") == "" {
		return fmt.Errorf("bank imap requires BANK_URL (http/https, without credentials, query or fragment) and BANK_TOKEN")
	}
	remote := client.New(destination, os.Getenv("BANK_TOKEN"))
	importer := func(ctx context.Context, source, path string, observation eml.MailImportContext) (eml.Result, error) {
		return client.ImportFile[eml.Result](ctx, remote, "eml", source, path, &observation)
	}
	err = imapsync.Run(ctx, config, destination, importer, *once, func(event imapsync.Event) {
		if err := encoder.Encode(event); err != nil {
			fmt.Fprintf(os.Stderr, "bank: write IMAP status: %v\n", err)
		}
	})
	if errors.Is(err, context.Canceled) && ctx.Err() != nil {
		return nil
	}
	return err
}
