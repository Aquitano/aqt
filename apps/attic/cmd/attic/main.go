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
	"slices"
	"strconv"
	"strings"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

var errMissingFlagValue = errors.New("expected a value")

type cli struct {
	Scan     scanCmd     `cmd:"" help:"Index a folder and its descendants."`
	Verify   verifyCmd   `cmd:"" help:"Run a maintenance check against stored file hashes."`
	Search   searchCmd   `cmd:"" help:"Find files, archive members and document text."`
	Show     showCmd     `cmd:"" help:"Show an entry or every place a content lives."`
	Get      getCmd      `cmd:"" help:"Retrieve one verified file to a new destination."`
	Text     textCmd     `cmd:"" help:"Print a document's extracted text."`
	Metadata metadataCmd `cmd:"" help:"Print embedded image, document, audio and video tags."`
	Enrich   enrichCmd   `cmd:"" help:"Explicitly run OCR or image descriptions."`
	Analysis analysisCmd `cmd:"" help:"Compare stored OCR and descriptions by model."`
	Volumes  volumesCmd  `cmd:"" help:"List known volumes and their last scans."`
	Scans    scansCmd    `cmd:"" help:"List scan history, phase times and counts."`
	Dupes    dupesCmd    `cmd:"" help:"Find contents stored more than once."`
	Coverage coverageCmd `cmd:"" help:"Report content on fewer than two recorded volumes."`
	Skips    skipsCmd    `cmd:"" help:"Show what a scan left out and why."`
	Stats    statsCmd    `cmd:"" help:"Show catalogue totals."`
	Config   configCmd   `cmd:"" help:"Show the configuration and effective rules."`
	Help     helpCmd     `cmd:"" help:"Show help for a command."`
}

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 0 {
		parser := newParser(&cli{})
		parser.Stdout = os.Stderr
		if err := printHelp(parser, nil); err != nil {
			fmt.Fprintln(os.Stderr, "attic:", err)
		}
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		stop()
	}()
	if err := execute(ctx, args); err != nil {
		fmt.Fprintln(os.Stderr, "attic:", err)
		if _, ok := errors.AsType[*kong.ParseError](err); ok || errors.Is(err, errMissingFlagValue) {
			return 2
		}
		return 1
	}
	return 0
}

func newParser(root *cli) *kong.Kong {
	return kong.Must(root,
		kong.Name("attic"),
		kong.Description("Search files on disks that come and go."),
		kong.WithHyphenPrefixedParameters(true),
	)
}

func execute(ctx context.Context, args []string) error {
	parsed, err := parseCLI(&cli{}, args)
	if err != nil {
		return err
	}
	parsed.BindTo(ctx, (*context.Context)(nil))
	return parsed.Run()
}

func parseCLI(root *cli, args []string) (*kong.Context, error) {
	parser := newParser(root)
	for _, command := range parser.Model.Children {
		if len(args) == 0 || command.Name != args[0] {
			continue
		}
		args = slices.Clone(args)
		flags := map[string]*kong.Flag{}
		for _, group := range command.AllFlags(false) {
			for _, flag := range group {
				flags["--"+flag.Name] = flag
				flags["-"+flag.Name] = flag
				if flag.Short != 0 {
					flags["-"+string(flag.Short)] = flag
				}
			}
		}
		options, words := []string{args[0]}, []string{}
		for i := 1; i < len(args); i++ {
			arg := args[i]
			if arg == "--" {
				words = append(words, args[i+1:]...)
				break
			}
			if len(arg) > 1 && strings.HasPrefix(arg, "-") {
				name, value, inline := strings.Cut(arg, "=")
				flag, ok := flags[name]
				if !ok {
					return parser.Parse(args)
				}
				arg = "--" + flag.Name
				if inline {
					if flag.IsBool() {
						if boolean, err := strconv.ParseBool(value); err == nil {
							value = strconv.FormatBool(boolean)
						}
					}
					arg += "=" + value
				}
				args[i] = arg
				options = append(options, arg)
				if !flag.IsBool() && !inline {
					if i+1 == len(args) {
						return nil, fmt.Errorf("%s: %w", name, errMissingFlagValue)
					}
					i++
					options = append(options, args[i])
				}
			} else {
				words = append(words, arg)
			}
		}
		// Kong consumes a positional slice once; keep words separated by flags together.
		if len(command.Positional) == 1 && command.Positional[0].IsSlice() {
			return parser.Parse(slices.Concat(options, []string{"--"}, words))
		}
		break
	}
	return parser.Parse(args)
}

type helpCmd struct {
	Command []string `arg:"" optional:"" help:"Command to describe."`
}

func (cmd *helpCmd) Run(parsed *kong.Context) error {
	return printHelp(parsed.Kong, cmd.Command)
}

func printHelp(parser *kong.Kong, path []string) error {
	target, err := kong.Trace(parser, path)
	if err != nil {
		return err
	}
	if target.Error != nil {
		return target.Error
	}
	return target.PrintUsage(false)
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
