package imapsync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
)

type Event struct {
	Time       time.Time `json:"time"`
	Kind       string    `json:"kind"`
	Account    string    `json:"account"`
	Folder     string    `json:"folder,omitempty"`
	UID        uint32    `json:"uid,omitempty"`
	Result     Result    `json:"result"`
	Error      string    `json:"error,omitempty"`
	RetryAfter string    `json:"retry_after,omitempty"`
}

type Mailbox struct {
	Account  string   `json:"account"`
	Name     string   `json:"name"`
	Selected bool     `json:"selected"`
	Attrs    []string `json:"attributes"`
}

func Run(ctx context.Context, config Config, destination string, importer Importer, once bool, report func(Event)) error {
	if err := config.validate(); err != nil {
		return err
	}
	if destination == "" || importer == nil || config.StateDir == "" {
		return fmt.Errorf("IMAP collection requires a destination, importer and state directory")
	}
	interval, _ := time.ParseDuration(config.Interval)
	timeout, _ := time.ParseDuration(config.Timeout)
	connections := make([]*connector, 0, len(config.Accounts))
	for _, account := range config.Accounts {
		connection, err := newConnector(ctx, account, timeout)
		if err != nil {
			return fmt.Errorf("account %s: %w", account.ID, err)
		}
		connections = append(connections, connection)
	}
	st, err := openState(config.StateDir)
	if err != nil {
		return err
	}
	defer st.close()
	for _, connection := range connections {
		identity, _ := json.Marshal([]string{connection.account.Address, connection.username, connection.account.Source, strings.TrimRight(destination, "/")})
		digest := sha256.Sum256(identity)
		if err := st.bind(ctx, connection.account.ID, hex.EncodeToString(digest[:])); err != nil {
			return err
		}
	}
	if err := st.prune(); err != nil {
		return fmt.Errorf("remove abandoned IMAP staging directories: %w", err)
	}
	var reports sync.Mutex
	emit := func(event Event) {
		if report != nil {
			reports.Lock()
			defer reports.Unlock()
			report(event)
		}
	}
	var group errgroup.Group
	for _, connection := range connections {
		group.Go(func() error {
			failures := 0
			for {
				if err := ctx.Err(); err != nil {
					return err
				}
				result, err := syncAccount(ctx, connection, st, config, importer, emit)
				delay := interval
				event := Event{Time: time.Now().UTC(), Kind: "pass", Account: connection.account.ID, Result: result}
				if err != nil {
					failures++
					delay = retryDelay(failures)
					event.Error = err.Error()
					if !once {
						event.RetryAfter = delay.String()
					}
				} else {
					failures = 0
				}
				emit(event)
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if once {
					return err
				}
				timer := time.NewTimer(delay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return ctx.Err()
				case <-timer.C:
				}
			}
		})
	}
	return group.Wait()
}

func syncAccount(ctx context.Context, connection *connector, st *state, config Config, importer Importer, report func(Event)) (Result, error) {
	var result Result
	account := connection.account
	if err := st.attempt(ctx, account.ID); err != nil {
		return result, err
	}
	var failures []error
	blocked := make(map[string]bool)
	progress := func(folder string, uid uint32) {
		report(Event{Time: time.Now().UTC(), Kind: "checkpoint", Account: account.ID, Folder: folder, UID: uid, Result: result})
	}
	for _, folder := range account.Folders {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		point, err := flushQueued(ctx, st, config, account, folder, importer, &result)
		if err != nil {
			failures = append(failures, fmt.Errorf("folder %q pending upload: %w", folder, err))
			blocked[folder] = true
			continue
		}
		if point.UID != 0 {
			progress(folder, point.UID)
		}
	}
	for _, folder := range account.Folders {
		if blocked[folder] {
			continue
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		session, err := connection.connect(ctx)
		if err == nil {
			err = syncFolder(ctx, session, st, config, account, folder, importer, &result, func(uid uint32) { progress(folder, uid) })
			session.close()
		} else {
			failures = append(failures, fmt.Errorf("connect: %w", err))
			break
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("folder %q: %w", folder, err))
		}
	}
	outcome := errors.Join(failures...)
	return result, errors.Join(outcome, st.finish(ctx, account.ID, outcome))
}

func retryDelay(failures int) time.Duration {
	base := min(5*time.Second*time.Duration(1<<min(max(failures-1, 0), 6)), 4*time.Minute)
	return base + time.Duration(rand.Int64N(int64(base/4)+1))
}

func Check(ctx context.Context, config Config) ([]Mailbox, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}
	timeout, _ := time.ParseDuration(config.Timeout)
	mailboxes := []Mailbox{}
	var failures []error
	for _, account := range config.Accounts {
		connection, err := newConnector(ctx, account, timeout)
		if err != nil {
			failures = append(failures, fmt.Errorf("account %s: %w", account.ID, err))
			continue
		}
		found, err := checkAccount(ctx, connection)
		mailboxes = append(mailboxes, found...)
		if err != nil {
			failures = append(failures, fmt.Errorf("account %s: %w", account.ID, err))
		}
	}
	return mailboxes, errors.Join(failures...)
}

func checkAccount(ctx context.Context, connection *connector) ([]Mailbox, error) {
	session, err := connection.connect(ctx)
	if err != nil {
		return nil, err
	}
	defer session.close()
	stop := session.deadline()
	folders, err := session.client.List("", "*", nil).Collect()
	stop()
	if err != nil {
		return nil, err
	}
	mailboxes := make([]Mailbox, 0, len(folders))
	for _, folder := range folders {
		mailbox := Mailbox{Account: connection.account.ID, Name: folder.Mailbox, Selected: slices.Contains(connection.account.Folders, folder.Mailbox), Attrs: []string{}}
		for _, attr := range folder.Attrs {
			mailbox.Attrs = append(mailbox.Attrs, string(attr))
		}
		mailboxes = append(mailboxes, mailbox)
	}
	for _, folder := range connection.account.Folders {
		if _, err := session.selectFolder(folder); err != nil {
			return mailboxes, fmt.Errorf("selected folder %q: %w", folder, err)
		}
	}
	return mailboxes, nil
}
