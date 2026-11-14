package main

import (
	"context"
	"fmt"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/server"
)

type mailCmd struct {
	Source    string           `help:"Mail source (gmail, proton, ...)."`
	JSON      bool             `help:"JSON output."`
	Mailboxes mailMailboxesCmd `cmd:"" help:"List historically observed folders."`
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
