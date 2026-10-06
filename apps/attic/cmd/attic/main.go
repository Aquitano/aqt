// attic is the CLI for the file index of disks that come and go.
// Every read command supports --json so agents can consume the output.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

const usage = `attic — search the files on disks that come and go

Usage:
  attic scan <folder> [flags]         index a folder and everything below it
  attic search [words...] [flags]     find files and folders, mounted or not, inside archives and in documents
  attic show <id|ref> [--json]        one entry, or every place a content lives
  attic text <id|ref> [--json]        the words read from a document
  attic volumes [--json]              known volumes, what they hold, last scan
  attic dupes [flags]                 contents stored more than once
  attic skips [flags]                 what a scan left out, and why
  attic stats [--json]                the whole catalogue in numbers
  attic config [--volume v]           the configuration file and effective rules

Scan flags:
  --config f     configuration file (default: <UserConfigDir>/attic/config.toml)
  --no-hash      list only; hash on a later scan
  --volume id    the disk is this known volume (after a fingerprint question)
  --new-volume   the disk is a new volume, even if it resembles a known one
  --json         print the result as JSON

Search flags:
  --any          match entries with any word (default: every word)
  --volume v     a volume label or id
  --ext e        file extension, such as pdf
  --kind k       file, dir or link
  --under p      a folder or an archive: E:\Files when mounted, or /Files with --volume
  --limit n      default 20
  --offset n     skip this many ranked results
  --json         JSON output

Dupes flags:
  --min-size s   ignore smaller contents, such as 10M (default 1M)
  --same-volume  only copies that share a volume
  --limit n      default 20

Skips flags:
  --scan n       a scan id (default: the newest scan, of --volume if given)
  --volume v     the newest scan of this volume
  --reason r     list paths: excluded, name_only, too_big, link, remote, unreadable, changed,
                 too_deep, encrypted, damaged, not_archive, split, text_failed
  --rule r       list paths skipped by this rule, as the summary prints it
  --limit n      default 100

Environment:
  DATABASE_URL   default postgres://attic:attic@localhost:5436/attic?sslmode=disable
`

func main() { os.Exit(run()) }

func run() int {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var err error
	switch os.Args[1] {
	case "scan":
		err = cmdScan(ctx, os.Args[2:])
	case "search":
		err = cmdSearch(ctx, os.Args[2:])
	case "show":
		err = cmdShow(ctx, os.Args[2:])
	case "volumes":
		err = cmdVolumes(ctx, os.Args[2:])
	case "dupes":
		err = cmdDupes(ctx, os.Args[2:])
	case "skips":
		err = cmdSkips(ctx, os.Args[2:])
	case "text":
		err = cmdText(ctx, os.Args[2:])
	case "stats":
		err = cmdStats(ctx, os.Args[2:])
	case "config":
		err = cmdConfig(ctx, os.Args[2:])
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		return 2
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "attic:", err)
		return 1
	}
	return 0
}

func openStore(ctx context.Context) (*store.Store, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://attic:attic@localhost:5436/attic?sslmode=disable"
	}
	return store.Open(ctx, url)
}

// loadConfig reads --config when given, the default file otherwise, and
// returns the path it used.
func loadConfig(path string) (config.Config, string, error) {
	if path != "" {
		c, err := config.Load(path, true)
		return c, path, err
	}
	path, err := config.Path()
	if err != nil {
		return config.Config{}, "", err
	}
	c, err := config.Load(path, false)
	return c, path, err
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// interspersed lets flags follow positional arguments, as in
// `attic search minecraft --ext rar`, which the flag package alone stops at.
func interspersed(args []string, boolFlags map[string]bool) (flags, positional []string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			return flags, append(positional, args[i+1:]...)
		case len(a) > 1 && a[0] == '-':
			flags = append(flags, a)
			if !boolFlags[strings.TrimLeft(a, "-")] && !strings.Contains(a, "=") && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		default:
			positional = append(positional, a)
		}
	}
	return flags, positional
}

var errUsage = errors.New("see 'attic help'")
