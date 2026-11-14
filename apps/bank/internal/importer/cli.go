package importer

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
)

// RunFunc imports paths of one kind with the options given on the command
// line.
type RunFunc func(ctx context.Context, kind string, paths []string, options json.RawMessage, noExtract bool) error

// command is the `bank import <kind>` command of one kind. Its flags are the
// fields of the kind's options type, so a source declares its flags by
// declaring its options.
type command[O any] struct {
	Paths     []string `arg:"" name:"path" help:"Input files or directories; a directory is packed into one zip. - reads stdin."`
	Options   O        `embed:""`
	NoExtract bool     `help:"Skip reading text out of attachments."`
	kind      string
	run       RunFunc
}

func (c *command[O]) Run(ctx context.Context) error {
	options, err := json.Marshal(c.Options)
	if err != nil {
		return err
	}
	return c.run(ctx, c.kind, c.Paths, options, c.NoExtract)
}

func newCommand[O any](kind string) func(RunFunc) any {
	return func(run RunFunc) any { return &command[O]{kind: kind, run: run} }
}

// Commands returns one kong plugin per kind for a command group such as
// `bank import`: kong reads a subcommand's name and help from its struct
// tag, so each kind gets a struct type built for it.
func (r Registry) Commands(run RunFunc) []any {
	out := make([]any, len(r))
	for i, k := range r {
		cmd := reflect.ValueOf(k.command(run))
		field := reflect.StructField{
			Name: "Command",
			Type: cmd.Elem().Type(),
			Tag:  reflect.StructTag(fmt.Sprintf(`cmd:"" name:%q help:%q`, k.Name, k.Help)),
		}
		plugin := reflect.New(reflect.StructOf([]reflect.StructField{field}))
		plugin.Elem().Field(0).Set(cmd.Elem())
		out[i] = plugin.Interface()
	}
	return out
}
