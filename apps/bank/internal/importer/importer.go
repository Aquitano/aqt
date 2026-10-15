// Package importer is the one table of import kinds. The CLI, the inbox sweep
// and the server all import through it, so every kind is recorded in
// import_reports the same way. A new kind still needs its command in
// cmd/bank/import.go and, to be swept from the inbox, an entry in inbox.Kinds.
package importer

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/aichat"
	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/discord"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/generic"
	"github.com/aquitano/aqt/apps/bank/internal/linkedin"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/whatsapp"
	"github.com/aquitano/aqt/apps/bank/internal/youtube"
)

// Target is the archive an import writes into.
type Target struct {
	Store      *store.Store
	Blobs      *blob.Store
	ArchiveDir string
}

// Input is one file to import. Each kind reads the fields it understands.
type Input struct {
	Path      string
	Source    string
	Account   string
	DateOrder string
	Mail      *eml.MailImportContext
}

type kind struct {
	name          string
	defaultSource string
	run           func(context.Context, Target, Input) (any, error)
	decode        func([]byte) (any, error)
}

func register[T any](name, defaultSource string, run func(context.Context, Target, Input) (T, error)) kind {
	return kind{
		name:          name,
		defaultSource: defaultSource,
		run: func(ctx context.Context, t Target, in Input) (any, error) {
			res, err := run(ctx, t, in)
			return res, err
		},
		decode: func(raw []byte) (any, error) {
			var res T
			err := json.Unmarshal(raw, &res)
			return res, err
		},
	}
}

func media(name string) kind {
	return register(name, "", func(ctx context.Context, t Target, in Input) (mediaimport.Result, error) {
		return mediaimport.Import(ctx, t.Store, t.Blobs, t.ArchiveDir, name, in.Path, mediaimport.Options{Source: in.Source, Account: in.Account, NetflixDateOrder: in.DateOrder})
	})
}

var kinds = []kind{
	register("whatsapp", "", func(ctx context.Context, t Target, in Input) (whatsapp.Result, error) {
		return whatsapp.Import(ctx, t.Store, t.Blobs, t.ArchiveDir, in.Path)
	}),
	register("eml", "proton", func(ctx context.Context, t Target, in Input) (eml.Result, error) {
		return eml.ImportEmlPath(ctx, t.Store, t.Blobs, t.ArchiveDir, in.Source, in.Path, in.Mail)
	}),
	register("mbox", "gmail", func(ctx context.Context, t Target, in Input) (eml.Result, error) {
		return eml.ImportMbox(ctx, t.Store, t.Blobs, t.ArchiveDir, in.Source, in.Path, in.Mail)
	}),
	register("discord", "", func(ctx context.Context, t Target, in Input) (discord.Result, error) {
		return discord.Import(ctx, t.Store, t.ArchiveDir, in.Path)
	}),
	register("linkedin", "", func(ctx context.Context, t Target, in Input) (linkedin.Result, error) {
		return linkedin.Import(ctx, t.Store, t.ArchiveDir, in.Path)
	}),
	register("youtube", "", func(ctx context.Context, t Target, in Input) (youtube.Result, error) {
		return youtube.Import(ctx, t.Store, t.ArchiveDir, in.Path)
	}),
	register("chatgpt", "", func(ctx context.Context, t Target, in Input) (aichat.Result, error) {
		return aichat.ImportChatGPT(ctx, t.Store, t.Blobs, t.ArchiveDir, in.Path)
	}),
	register("claude", "", func(ctx context.Context, t Target, in Input) (aichat.Result, error) {
		return aichat.ImportClaude(ctx, t.Store, t.ArchiveDir, in.Path)
	}),
	register("json", "", importJSONFile),
	media("netflix"),
	media("youtube-media"),
	media("library"),
}

func names() []string {
	names := make([]string, len(kinds))
	for i, k := range kinds {
		names[i] = k.name
	}
	return names
}

func lookup(name string) (kind, error) {
	i := slices.IndexFunc(kinds, func(k kind) bool { return k.name == name })
	if i < 0 {
		return kind{}, fmt.Errorf("unknown import kind %q (%s)", name, strings.Join(names(), ", "))
	}
	return kinds[i], nil
}

// DefaultSource is the source a kind files messages under when none is given.
func DefaultSource(name string) string {
	k, _ := lookup(name)
	return k.defaultSource
}

// Run imports one input and records the attempt in import_reports. The result
// is the importer's own Result type.
func Run(ctx context.Context, t Target, name string, in Input) (any, error) {
	k, err := lookup(name)
	if err != nil {
		return nil, err
	}
	if in.Source == "" {
		in.Source = k.defaultSource
	}
	return store.RunImport(ctx, t.Store, name, in.Path, func(ctx context.Context) (any, error) { return k.run(ctx, t, in) })
}

// Decode reads a result a remote server returned for this kind into the same
// type Run returns locally.
func Decode(name string, raw []byte) (any, error) {
	k, err := lookup(name)
	if err != nil {
		return nil, err
	}
	return k.decode(raw)
}

// importJSONFile reads a local file, or stdin for "-". Attachment paths in the
// entries resolve on this machine, which is why the server never routes an
// upload here.
func importJSONFile(ctx context.Context, t Target, in Input) (generic.Result, error) {
	var input []byte
	var rawRef string
	var err error
	if in.Path == "-" {
		if input, err = io.ReadAll(os.Stdin); err == nil {
			sum := sha256.Sum256(input)
			rawRef, err = archive.Write(t.ArchiveDir, "json", fmt.Sprintf("stdin-%x.json", sum[:6]), input)
		}
	} else if input, err = os.ReadFile(in.Path); err == nil {
		rawRef, err = archive.Copy(t.ArchiveDir, "json", in.Path)
	}
	if err != nil {
		return generic.Result{}, err
	}
	return generic.Import(ctx, t.Store, t.Blobs, in.Source, rawRef, input, time.Now(), true)
}
