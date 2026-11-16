// Package importer is the one way into the archive. It stores every input as a
// raw input before parsing it, runs the registered source for the input's
// kind, and writes what the source emits through one sink. The CLI, the
// server's import routes, the inbox sweep, Gmail sync, the IMAP collector and
// replay all import through it.
package importer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Target is the archive an import writes into and the kinds it reads.
type Target struct {
	Store *store.Store
	Blobs *blob.Store
	Kinds Registry
}

// Registry is the list of kinds an archive imports. Package sources holds
// the one the binary uses; a test can register only the source it tests.
type Registry []Kind

// Kind is one registered source with its options type erased.
type Kind struct {
	Name string
	Help string
	// Options is the source's options type, for the CLI flags and the
	// server's schema.
	Options reflect.Type
	// normalize decodes options strictly, fills their defaults, validates
	// them and returns them in the form they are stored in.
	normalize func(json.RawMessage) (json.RawMessage, error)
	parse     func(context.Context, ingest.Raw, json.RawMessage, ingest.Emitter) error
	command   func(RunFunc) any
}

// Register erases a source's options type so the registry can hold every
// kind in one list.
func Register[O any](s ingest.Source[O], help string) Kind {
	return Kind{
		Name:    s.Kind(),
		Help:    help,
		Options: reflect.TypeFor[O](),
		command: newCommand[O](s.Kind()),
		normalize: func(raw json.RawMessage) (json.RawMessage, error) {
			o, err := decodeOptions[O](raw)
			if err != nil {
				return nil, err
			}
			return json.Marshal(o)
		},
		parse: func(ctx context.Context, raw ingest.Raw, options json.RawMessage, out ingest.Emitter) error {
			o, err := decodeOptions[O](options)
			if err != nil {
				return err
			}
			return s.Parse(ctx, raw, o, out)
		},
	}
}

func decodeOptions[O any](raw json.RawMessage) (O, error) {
	var o O
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage(`{}`)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return o, fail.Invalidf("options: %v", err)
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return o, fail.Invalidf("options must be one JSON object")
	}
	if n, ok := any(&o).(ingest.Normalizer); ok {
		if err := n.Normalize(); err != nil {
			return o, fail.Invalidf("options: %v", err)
		}
	}
	return o, nil
}

// Names lists the registered kinds.
func (r Registry) Names() []string {
	names := make([]string, len(r))
	for i, k := range r {
		names[i] = k.Name
	}
	return names
}

func (r Registry) Lookup(name string) (Kind, error) {
	i := slices.IndexFunc(r, func(k Kind) bool { return k.Name == name })
	if i < 0 {
		return Kind{}, fail.Invalidf("unknown import kind %q (%s)", name, strings.Join(r.Names(), ", "))
	}
	return r[i], nil
}

// Normalize checks options for a kind and returns them as they are stored.
func (k Kind) Normalize(options json.RawMessage) (json.RawMessage, error) {
	return k.normalize(options)
}

// Store keeps an input's bytes and records it as a raw input of kind, before
// anything parses it. Storing the same input again returns the same row.
func Store(ctx context.Context, t Target, kind, name string, r io.Reader, options json.RawMessage) (int64, error) {
	k, err := t.Kinds.Lookup(kind)
	if err != nil {
		return 0, err
	}
	options, err = k.Normalize(options)
	if err != nil {
		return 0, err
	}
	if err := ValidName(name); err != nil {
		return 0, err
	}
	digest, size, err := t.Blobs.Put(ctx, r)
	if err != nil {
		return 0, fail.Opf("store %s: %w", name, err)
	}
	id, err := t.Store.AddRawInput(ctx, kind, name, digest, size, options)
	if err != nil {
		return 0, fail.Opf("record %s: %w", name, err)
	}
	return id, nil
}

// ValidName checks an input's original name: one path component.
func ValidName(name string) error {
	if name == "" || name == "." || name == ".." || name != filepath.Base(name) || strings.ContainsAny(name, "/\\\x00") || len(name) > 1024 {
		return fail.Invalidf("invalid input name %q", name)
	}
	return nil
}

// Run parses a stored input with today's source for its kind and records the
// outcome on it. A parse failure is the input's, recorded and returned as
// invalid input; the input stays stored and can be replayed after a fix.
func Run(ctx context.Context, t Target, id int64) (store.RawInput, error) {
	raw, err := t.Store.RawInput(ctx, id)
	if err != nil {
		return raw, fail.Opf("raw input %d: %w", id, err)
	}
	k, err := t.Kinds.Lookup(raw.Kind)
	if err != nil {
		return raw, err
	}
	out := newSink(ctx, t, id)
	err = k.parse(ctx, ingest.Raw{Name: raw.Name, Path: t.Blobs.Path(raw.BLAKE3)}, raw.Options, out)
	if err == nil {
		err = out.flush()
	}
	if err != nil && !fail.IsOp(err) && !errors.Is(err, fail.ErrInvalid) {
		err = fail.Invalidf("%s: %v", raw.Name, err)
	}
	// An import cut short by a dropped client or a shutdown stays running,
	// which marks it interrupted: neither the input nor its parser failed.
	if err != nil && ctx.Err() != nil {
		return raw, err
	}
	if finishErr := t.Store.FinishRawInput(ctx, id, out.report, err); finishErr != nil {
		return raw, errors.Join(err, fail.Opf("record outcome of raw input %d: %w", id, finishErr))
	}
	updated, readErr := t.Store.RawInput(context.WithoutCancel(ctx), id)
	if readErr != nil {
		return raw, errors.Join(err, fail.Op(readErr))
	}
	return updated, err
}

// Import stores an input and runs it.
func Import(ctx context.Context, t Target, kind, name string, r io.Reader, options json.RawMessage) (store.RawInput, error) {
	id, err := Store(ctx, t, kind, name, r, options)
	if err != nil {
		return store.RawInput{}, err
	}
	return Run(ctx, t, id)
}

// Replay runs every stored input of the given kinds, or of every kind, in the
// order they first arrived. An input today's source still rejects is reported
// to each and skipped; a failure of the archive itself stops the replay.
func Replay(ctx context.Context, t Target, kinds []string, each func(store.RawInput, error)) error {
	for _, kind := range kinds {
		if _, err := t.Kinds.Lookup(kind); err != nil {
			return err
		}
	}
	ids, err := t.Store.RawInputIDs(ctx, kinds)
	if err != nil {
		return fail.Op(err)
	}
	for _, id := range ids {
		raw, err := Run(ctx, t, id)
		if fail.IsOp(err) {
			return fmt.Errorf("raw input %d: %w", id, err)
		}
		each(raw, err)
	}
	return nil
}
