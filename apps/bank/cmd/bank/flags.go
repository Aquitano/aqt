package main

import (
	"errors"
	"strings"

	"github.com/alecthomas/kong"
)

var errCommandHelp = errors.New("command help requested")

type CommandArguments struct {
	Args []string `arg:"" optional:"" name:"arguments"`
	Help bool     `name:"help" short:"h" help:"Show command help."`
}

func (a *CommandArguments) commandArguments() *CommandArguments { return a }

func parseCommand(name string, target interface{ commandArguments() *CommandArguments }, args []string, defaults ...map[string]string) error {
	options := []kong.Option{kong.Name("bank " + name), kong.NoDefaultHelp()}
	for _, values := range defaults {
		options = append(options, kong.Vars(values))
	}
	parser, err := kong.New(target, options...)
	if err != nil {
		return err
	}
	// Preserve flag's existing -long spelling. Kong handles interspersed flags,
	// repeated values and the -- terminator; values after -- stay untouched.
	normalized := append([]string(nil), args...)
	for i := 0; i < len(normalized); i++ {
		raw := normalized[i]
		if raw == "--" {
			break
		}
		if !strings.HasPrefix(raw, "-") || raw == "-" {
			continue
		}
		name, _, hasValue := strings.Cut(strings.TrimLeft(raw, "-"), "=")
		for _, flag := range parser.Model.Flags {
			if name != flag.Name && name != string(flag.Short) {
				continue
			}
			if !strings.HasPrefix(raw, "--") && name == flag.Name {
				normalized[i] = "-" + raw
			}
			if !hasValue && !flag.IsBool() && i+1 < len(normalized) {
				normalized[i] += "=" + normalized[i+1]
				normalized = append(normalized[:i+1], normalized[i+2:]...)
			}
			break
		}
	}
	parsed, err := parser.Parse(normalized)
	if err != nil {
		return err
	}
	if target.commandArguments().Help {
		if err := parsed.PrintUsage(false); err != nil {
			return err
		}
		return errCommandHelp
	}
	return nil
}

func commandArg(args []string, index int) string {
	if index < 0 || index >= len(args) {
		return ""
	}
	return args[index]
}
