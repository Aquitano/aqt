package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
)

const MaxPublicationBytes = 32 << 20

// Publication is a checked set of Markdown pages with the original bytes of
// each, built on the machine that holds the directory and imported as one
// JSON document.
type Publication struct {
	Source            string         `json:"source"`
	Account           string         `json:"account"`
	Pages             []library.Page `json:"pages"`
	Inputs            []Input        `json:"inputs"`
	AllowConfidential bool           `json:"allow_confidential"`
}

type PublicationOptions struct {
	Source            string
	Account           string
	MaxSensitivity    string
	AllowConfidential bool
}

// BuildPublication scans a selected Markdown directory into a publication.
func BuildPublication(dir string, opts PublicationOptions) (Publication, error) {
	if opts.Source == "" {
		opts.Source = "markdown"
	}
	opts.Account = markdownAccount(dir, opts.Account)
	pages, inputs, err := parseMarkdown(dir, opts)
	if err != nil {
		return Publication{}, err
	}
	publication := Publication{Source: opts.Source, Account: opts.Account, Pages: pages, Inputs: inputs, AllowConfidential: opts.AllowConfidential}
	if err := publication.Validate(); err != nil {
		return Publication{}, err
	}
	return publication, nil
}

// Markdown publishes a Publication document. Its pages replace every page
// published before under the same source and account.
type Markdown struct{}

type MarkdownOptions struct{}

func (Markdown) Kind() string { return "markdown" }

func (Markdown) Parse(_ context.Context, raw ingest.Raw, _ MarkdownOptions, out ingest.Emitter) error {
	f, err := raw.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > MaxPublicationBytes {
		return fmt.Errorf("publication exceeds the 32 MiB limit")
	}
	var publication Publication
	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&publication); err != nil {
		return fmt.Errorf("publication: %w", err)
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("publication must contain one JSON object")
	}
	if err := publication.Validate(); err != nil {
		return err
	}
	return out.Pages(ingest.Pages{Source: publication.Source, Account: publication.Account, Pages: publication.Pages})
}

func sensitivityRank(s string) int {
	switch s {
	case "normal":
		return 0
	case "personal":
		return 1
	case "confidential":
		return 2
	default:
		return -1
	}
}

func (p Publication) Validate() error {
	if err := ingest.ValidSource(p.Source); err != nil {
		return err
	}
	if p.Account == "" || len(p.Account) > 4096 || strings.ContainsRune(p.Account, 0) {
		return fmt.Errorf("publication requires a stable nonempty account namespace")
	}
	if p.Pages == nil || p.Inputs == nil {
		return fmt.Errorf("publication requires explicit pages and inputs arrays")
	}
	if len(p.Pages) != len(p.Inputs) || len(p.Pages) > 100000 {
		return fmt.Errorf("publication requires one original input per page")
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if len(raw) > MaxPublicationBytes {
		return fmt.Errorf("publication exceeds the 32 MiB limit")
	}
	inputs := map[string]Input{}
	for _, input := range p.Inputs {
		if !fs.ValidPath(input.Name) || filepath.IsAbs(input.Name) || strings.ContainsAny(input.Name, "\\:") || !strings.EqualFold(filepath.Ext(input.Name), ".md") {
			return fmt.Errorf("invalid publication input path %q", input.Name)
		}
		for _, part := range strings.Split(input.Name, "/") {
			if strings.HasPrefix(part, ".") || part == "archive" || part == "raw" || part == "node_modules" {
				return fmt.Errorf("publication input path %q is excluded", input.Name)
			}
		}
		if _, exists := inputs[input.Name]; exists {
			return fmt.Errorf("duplicate publication input %q", input.Name)
		}
		if len(input.Bytes) > 8<<20 {
			return fmt.Errorf("publication page %s exceeds 8 MiB", input.Name)
		}
		inputs[input.Name] = input
	}
	opts := PublicationOptions{Source: p.Source, Account: p.Account, MaxSensitivity: "personal", AllowConfidential: p.AllowConfidential}
	if p.AllowConfidential {
		opts.MaxSensitivity = "confidential"
	}
	for _, page := range p.Pages {
		input, ok := inputs[page.Path]
		if !ok {
			return fmt.Errorf("page %s has no selected original input", page.Path)
		}
		delete(inputs, page.Path)
		expected, err := markdownDocument(input, opts, page.Path)
		if err != nil {
			return fmt.Errorf("page %s: %w", page.Path, err)
		}
		if expected == nil {
			return fmt.Errorf("page %s is excluded or exceeds publication sensitivity", page.Path)
		}
		allowed, err := sensitivityAllowed(page.Sensitivity, opts)
		if err != nil {
			return err
		}
		if !allowed || sensitivityRank(page.Sensitivity) < sensitivityRank(expected.Sensitivity) {
			return fmt.Errorf("page %s has invalid publication sensitivity", page.Path)
		}
		if page.Identity != expected.Identity || page.ID != expected.ID || page.ContentHash != expected.ContentHash || page.Revision != expected.Revision || page.Title != expected.Title || page.Body != expected.Body || !reflect.DeepEqual(nonNil(page.Answers), expected.Answers) || !reflect.DeepEqual(nonNil(page.Tags), expected.Tags) || !reflect.DeepEqual(nonNil(page.Aliases), expected.Aliases) {
			return fmt.Errorf("page %s does not match its original bytes, metadata or identity", page.Path)
		}
		if page.Provenance != (library.Provenance{Locator: input.Name}) {
			return fmt.Errorf("page %s has invalid source provenance", page.Path)
		}
	}
	return (library.ImportBatch{Version: 1, Pages: p.Pages}).Validate()
}
