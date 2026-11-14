package mediaimport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
)

// Input is one file read out of an input, kept with the name it had there.
type Input struct {
	Name  string `json:"name"`
	Bytes []byte `json:"bytes"`
}

func identity(source, account, external string) library.Identity {
	return library.Identity{Source: source, Account: account, ExternalID: external}
}
func provenance(name, locator string) library.Provenance {
	return library.Provenance{Locator: name + ": " + locator}
}
func emptyBatch() library.ImportBatch {
	return library.ImportBatch{Version: 1, Items: []library.Item{}, Activity: []library.Activity{}, Collections: []library.Collection{}, Files: []library.File{}, Pages: []library.Page{}}
}

func emitBatch(out ingest.Emitter, kind string, batch library.ImportBatch) error {
	if err := batch.Validate(); err != nil {
		return fmt.Errorf("invalid %s import: %w", kind, err)
	}
	return out.Library(batch)
}

// Bundle reads a versioned JSON library bundle. The files it names must
// already be in the blob store; pages go through Markdown instead.
type Bundle struct{}

type BundleOptions struct{}

func (Bundle) Kind() string { return "library" }

func (b Bundle) Parse(_ context.Context, raw ingest.Raw, _ BundleOptions, out ingest.Emitter) error {
	f, err := raw.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	batch := emptyBatch()
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&batch); err != nil {
		return fmt.Errorf("library bundle: %w", err)
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("library bundle must contain one JSON object")
	}
	if len(batch.Pages) > 0 {
		return fmt.Errorf("Markdown pages require a checked publication; use bank library index or the pages/publication interface")
	}
	fallback := provenance(raw.Name, "library bundle").Locator
	set := func(p *library.Provenance) {
		if p.Locator == "" {
			p.Locator = fallback
		}
	}
	for i := range batch.Items {
		set(&batch.Items[i].Provenance)
	}
	for i := range batch.Activity {
		set(&batch.Activity[i].Provenance)
	}
	for i := range batch.Collections {
		if s := batch.Collections[i].Snapshot; s != nil {
			set(&s.Provenance)
		}
	}
	for i := range batch.Files {
		set(&batch.Files[i].Provenance)
	}
	return emitBatch(out, b.Kind(), batch)
}
