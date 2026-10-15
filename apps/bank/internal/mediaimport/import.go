package mediaimport

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/jackc/pgx/v5/pgconn"
)

type Options struct {
	Source            string
	Account           string
	NetflixDateOrder  string
	CapturedAt        library.Date
	MaxSensitivity    string
	AllowConfidential bool
}

type RawInput struct {
	Name  string `json:"name"`
	Bytes []byte `json:"bytes"`
}
type Parsed struct {
	Batch       library.ImportBatch
	Inputs      []RawInput
	Skipped     int
	Ads         int
	Diagnostics []string
}
type Result struct {
	library.ImportResult
	Skipped     int      `json:"skipped"`
	Ads         int      `json:"ads,omitempty"`
	Diagnostics []string `json:"diagnostics"`
}

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func identity(opts Options, external string) library.Identity {
	return library.Identity{Source: opts.Source, Account: opts.Account, ExternalID: external}
}
func provenance(name, locator string) library.Provenance {
	return library.Provenance{RawRef: "input:" + name, Locator: name + ": " + locator}
}
func preserveLibraryInput(archiveDir, source string, input RawInput) (string, error) {
	name := digest(input.Bytes) + "-" + filepath.Base(input.Name)
	ref, err := archive.Write(filepath.Join(archiveDir, "library"), source, name, input.Bytes)
	if err != nil {
		return "", err
	}
	return "library/" + filepath.ToSlash(ref), nil
}
func emptyBatch() library.ImportBatch {
	return library.ImportBatch{Version: 1, Items: []library.Item{}, Activity: []library.Activity{}, Collections: []library.Collection{}, Files: []library.File{}, Pages: []library.Page{}}
}

func Parse(kind, inputPath string, opts Options) (Parsed, error) {
	if opts.Source == "" {
		opts.Source = kind
		if kind == "youtube-media" {
			opts.Source = "youtube"
		}
	}
	if err := archive.ValidSource(opts.Source); err != nil {
		return Parsed{}, err
	}
	if err := opts.CapturedAt.Validate(); err != nil {
		return Parsed{}, err
	}
	var p Parsed
	var err error
	switch kind {
	case "netflix":
		p, err = parseNetflix(inputPath, opts)
	case "youtube", "youtube-media":
		p, err = parseYouTube(inputPath, opts)
	case "library":
		p, err = parseBundle(inputPath, opts)
	case "markdown":
		p, err = parseMarkdown(inputPath, opts)
	default:
		return Parsed{}, fmt.Errorf("unsupported library import %q", kind)
	}
	if err != nil {
		var ioErr *os.PathError
		if errors.As(err, &ioErr) {
			return p, fail.Op(err)
		}
		return p, err
	}
	if err := p.Batch.Validate(); err != nil {
		return p, fmt.Errorf("invalid %s import: %w", kind, err)
	}
	return p, nil
}

func Import(ctx context.Context, st *store.Store, blobs *blob.Store, archiveDir, kind, inputPath string, opts Options) (Result, error) {
	if kind == "markdown" {
		publication, err := BuildPublication(inputPath, opts)
		if err != nil {
			return Result{}, err
		}
		return Publish(ctx, st, archiveDir, publication)
	}
	if opts.Source == "" {
		opts.Source = kind
		if kind == "youtube-media" {
			opts.Source = "youtube"
		}
	}
	parsed, err := Parse(kind, inputPath, opts)
	result := Result{Skipped: parsed.Skipped, Ads: parsed.Ads, Diagnostics: parsed.Diagnostics}
	if err != nil {
		return result, err
	}
	if err := verifyBundleFiles(blobs, parsed.Batch.Files); err != nil {
		return result, err
	}
	for _, message := range parsed.Diagnostics {
		store.ImportIssue(ctx, message)
	}
	refs := map[string]string{}
	for _, input := range parsed.Inputs {
		ref, err := preserveLibraryInput(archiveDir, opts.Source, input)
		if err != nil {
			return result, fail.Opf("preserve %s: %w", input.Name, err)
		}
		refs["input:"+input.Name] = ref
	}
	replace := func(p *library.Provenance) {
		if ref, ok := refs[p.RawRef]; ok {
			p.RawRef = ref
		}
	}
	for i := range parsed.Batch.Items {
		replace(&parsed.Batch.Items[i].Provenance)
		for j := range parsed.Batch.Items[i].Evidence {
			replace(&parsed.Batch.Items[i].Evidence[j])
		}
	}
	for i := range parsed.Batch.Activity {
		replace(&parsed.Batch.Activity[i].Provenance)
		for j := range parsed.Batch.Activity[i].Evidence {
			replace(&parsed.Batch.Activity[i].Evidence[j])
		}
	}
	for i := range parsed.Batch.Collections {
		if s := parsed.Batch.Collections[i].Snapshot; s != nil {
			replace(&s.Provenance)
		}
	}
	for i := range parsed.Batch.Files {
		replace(&parsed.Batch.Files[i].Provenance)
	}
	for i := range parsed.Batch.Pages {
		replace(&parsed.Batch.Pages[i].Provenance)
	}
	result.ImportResult, err = st.ImportLibrary(ctx, parsed.Batch)
	return result, importFailure(err)
}

func importFailure(err error) error {
	var pgErr *pgconn.PgError
	if errors.Is(err, library.ErrConflict) || errors.Is(err, library.ErrInvalid) ||
		(errors.As(err, &pgErr) && (strings.HasPrefix(pgErr.Code, "22") || strings.HasPrefix(pgErr.Code, "23") || pgErr.Code == "54000")) {
		return err
	}
	return fail.Op(err)
}

func parseBundle(inputPath string, opts Options) (Parsed, error) {
	raw, err := os.ReadFile(inputPath)
	if err != nil {
		return Parsed{}, err
	}
	p := Parsed{Batch: emptyBatch(), Inputs: []RawInput{{Name: filepath.Base(inputPath), Bytes: raw}}, Diagnostics: []string{}}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p.Batch); err != nil {
		return p, fmt.Errorf("library bundle: %w", err)
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return p, fmt.Errorf("library bundle must contain one JSON object")
	}
	if len(p.Batch.Pages) > 0 {
		return p, fmt.Errorf("Markdown pages require a checked publication; use bank library index or the pages/publication interface")
	}
	fallback := provenance(filepath.Base(inputPath), "library bundle")
	set := func(p *library.Provenance) {
		if p.RawRef == "" {
			*p = fallback
		}
	}
	for i := range p.Batch.Items {
		set(&p.Batch.Items[i].Provenance)
	}
	for i := range p.Batch.Activity {
		set(&p.Batch.Activity[i].Provenance)
	}
	for i := range p.Batch.Collections {
		if s := p.Batch.Collections[i].Snapshot; s != nil {
			set(&s.Provenance)
		}
	}
	for i := range p.Batch.Files {
		set(&p.Batch.Files[i].Provenance)
	}
	return p, nil
}

func verifyBundleFiles(blobs *blob.Store, files []library.File) error {
	for _, file := range files {
		if blobs == nil {
			return fail.Opf("file %s requires the archive blob store", file.Filename)
		}
		if err := blob.ValidDigest(file.SHA256); err != nil {
			return err
		}
		input, err := os.Open(blobs.Path(file.SHA256))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("file %s has no preserved bytes: %w", file.Filename, err)
			}
			return fail.Opf("read preserved file %s: %w", file.Filename, err)
		}
		h := sha256.New()
		size, err := io.Copy(h, input)
		closeErr := input.Close()
		if err != nil {
			return fail.Op(err)
		}
		if closeErr != nil {
			return fail.Op(closeErr)
		}
		if hex.EncodeToString(h.Sum(nil)) != file.SHA256 {
			return fail.Opf("preserved file %s has corrupted bytes", file.Filename)
		}
		if size != file.SizeBytes {
			return fmt.Errorf("file %s does not match its declared size", file.Filename)
		}
	}
	return nil
}
