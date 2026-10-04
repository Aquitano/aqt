package mediaimport

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

const MaxPublicationBytes = 32 << 20

type Publication struct {
	Source            string         `json:"source"`
	Account           string         `json:"account"`
	Pages             []library.Page `json:"pages"`
	Inputs            []RawInput     `json:"inputs"`
	AllowConfidential bool           `json:"allow_confidential"`
}

func BuildPublication(inputPath string, opts Options) (Publication, error) {
	if opts.Source == "" {
		opts.Source = "markdown"
	}
	opts.Account = markdownAccount(inputPath, opts.Account)
	parsed, err := Parse("markdown", inputPath, opts)
	if err != nil {
		return Publication{}, err
	}
	publication := Publication{Source: opts.Source, Account: opts.Account, Pages: parsed.Batch.Pages, Inputs: parsed.Inputs, AllowConfidential: opts.AllowConfidential}
	if err := publication.Validate(); err != nil {
		return Publication{}, err
	}
	return publication, nil
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
	if err := archive.ValidSource(p.Source); err != nil {
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
	inputs := map[string]RawInput{}
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
	opts := Options{Source: p.Source, Account: p.Account, MaxSensitivity: "personal", AllowConfidential: p.AllowConfidential}
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
		if page.Provenance.RawRef != "input:"+input.Name {
			return fmt.Errorf("page %s has invalid source provenance", page.Path)
		}
	}
	return (library.ImportBatch{Version: 1, Pages: p.Pages}).Validate()
}

func Publish(ctx context.Context, st *store.Store, archiveDir string, publication Publication) (Result, error) {
	return store.RunImport(ctx, st, "markdown", "publication:"+publication.Account, func(ctx context.Context) (Result, error) {
		result := Result{Diagnostics: []string{}}
		if err := publication.Validate(); err != nil {
			return result, err
		}
		pages := append([]library.Page{}, publication.Pages...)
		refs := map[string]string{}
		for _, input := range publication.Inputs {
			ref, err := preserveLibraryInput(archiveDir, publication.Source, input)
			if err != nil {
				return result, fail.Opf("preserve %s: %w", input.Name, err)
			}
			refs[input.Name] = ref
		}
		for i := range pages {
			pages[i].Provenance.RawRef = refs[pages[i].Path]
		}
		var err error
		result.ImportResult, err = st.PublishLibraryPages(ctx, publication.Source, publication.Account, pages)
		return result, importFailure(err)
	})
}
