package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/aichat"
	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/discord"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/generic"
	"github.com/aquitano/aqt/apps/bank/internal/inbox"
	"github.com/aquitano/aqt/apps/bank/internal/linkedin"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/whatsapp"
	"github.com/aquitano/aqt/apps/bank/internal/youtube"
	"github.com/aquitano/aqt/packages/go/extract"
)

type importCmd struct {
	Whatsapp     importFilesCmd    `cmd:"" help:"WhatsApp \"Export chat\" files (.zip, or .txt beside its media)."`
	Eml          importFilesCmd    `cmd:"" name:"eml" help:".eml files or directories (default source: proton)."`
	Mbox         importFilesCmd    `cmd:"" name:"mbox" help:"mbox files (default source: gmail)."`
	MailTree     importMailTreeCmd `cmd:"" name:"mail-tree" help:"A folder tree of mail, preserving each folder."`
	Discord      importFilesCmd    `cmd:"" help:"Discord GDPR data package (zip or directory)."`
	Linkedin     importFilesCmd    `cmd:"" name:"linkedin" help:"LinkedIn data export (zip, csv or directory)."`
	Youtube      importFilesCmd    `cmd:"" name:"youtube" help:"YouTube watch history from Google Takeout (zip, directory or the history file)."`
	YoutubeMedia importMediaCmd    `cmd:"" name:"youtube-media" help:"YouTube history, playlists and music library."`
	Netflix      importMediaCmd    `cmd:"" help:"Netflix viewing activity CSV."`
	Library      importMediaCmd    `cmd:"" help:"Versioned media library bundle (JSON)."`
	Markdown     importMediaCmd    `cmd:"" help:"Checked Markdown page publication."`
	ChatGPT      importFilesCmd    `cmd:"" name:"chatgpt" help:"ChatGPT data export (zip, json or directory)."`
	Claude       importFilesCmd    `cmd:"" name:"claude" help:"Claude.ai data export (zip, json or directory)."`
	JSON         importFilesCmd    `cmd:"" name:"json" help:"Arbitrary JSON/NDJSON messages; - reads stdin."`
	Inbox        importInboxCmd    `cmd:"" help:"Sweep $BANK_DATA_DIR/inbox/<kind>/."`
}

type importFilesCmd struct {
	Paths     []string `arg:"" name:"path"`
	Source    string   `help:"Source the messages are filed under."`
	Mailbox   string   `help:"Historical mailbox observation for an EML or MBOX file."`
	NoExtract bool     `help:"Skip reading text out of attachments."`
}

func (c *importFilesCmd) Run(ctx context.Context, kctx *kong.Context) error {
	kind := kctx.Selected().Name
	source := c.Source
	if source == "" {
		source = defaultSource(kind)
	}
	if source != "" {
		if err := archive.ValidSource(source); err != nil {
			return err
		}
	}
	if c.Mailbox != "" {
		if kind != "eml" && kind != "mbox" {
			return fmt.Errorf("--mailbox requires eml or mbox")
		}
		return importMailboxFiles(ctx, kind, source, c.Mailbox, c.Paths, c.NoExtract)
	}
	if remote := client.FromEnv(); remote != nil {
		return importRemote(ctx, remote, kind, source, c.Paths)
	}

	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	for _, path := range c.Paths {
		res, err := importLocal(ctx, d, kind, source, path)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		printImportResult(kind, source, path, res)
	}
	return extractAfterImport(ctx, blobtext.Local{Store: d.st, Blobs: d.blobs}, c.NoExtract)
}

// extractAfterImport reads text out of whatever the import just stored, so a
// PDF is searchable the moment it lands rather than after a command nobody
// remembers to run. Newest content first: the batch is bounded, and a backlog
// of large pending blobs would otherwise consume all of it before reaching the
// file that just arrived.
//
// Only the cheap extractors run: OCR is minutes per document and needs tools
// that are deliberately absent from the deployed image, so it stays an
// explicit `bank extract --ocr`. Failures here are reported and not fatal —
// the messages are already archived, and text is rebuildable.
//
// What it did goes to stderr, not stdout: this runs inside `bank import inbox
// --json`, whose stdout is a JSON document an agent parses.
func extractAfterImport(ctx context.Context, a blobtext.Archive, skip bool) error {
	if skip || os.Getenv("BANK_EXTRACT") == "off" {
		return nil
	}
	o := extract.DefaultOptions()
	o.TempDir = stagingDir()
	sel := blobtext.Selection{Limit: blobtext.PostImportLimit, NewestFirst: true}
	sum, err := blobtext.Run(ctx, a, sel, o, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bank: reading attachment text: %v\n", err)
		return nil
	}
	if sum.Considered > 0 {
		fmt.Fprintf(os.Stderr, "attachment text: %d read, %d need OCR, %d messages reindexed\n",
			sum.ByStatus[string(extract.StatusOK)], sum.ByStatus[string(extract.StatusNeedsOCR)], sum.Reindexed)
	}
	return nil
}

func defaultSource(kind string) string {
	return map[string]string{"eml": "proton", "mbox": "gmail"}[kind]
}

// inboxSource is defaultSource for an unattended sweep, where refusing an
// entry for want of a --source would just leave the file sitting there: a JSON
// drop that names no source of its own lands under "json".
func inboxSource(kind string) string {
	if kind == "json" {
		return "json"
	}
	return defaultSource(kind)
}

// importLocal runs one importer against a local store. It is the single place
// that knows which importer owns which kind, shared by `bank import <kind>`
// and by the inbox sweep.
func importLocal(ctx context.Context, d *local, kind, source, path string) (any, error) {
	if kind == "netflix" || kind == "youtube-media" || kind == "library" {
		return mediaimport.Import(ctx, d.st, d.blobs, d.archiveDir, kind, path, mediaimport.Options{Source: source})
	}
	return store.RunImport(ctx, d.st, kind, path, func(ctx context.Context) (any, error) { return importLocalInput(ctx, d, kind, source, path) })
}

func importLocalInput(ctx context.Context, d *local, kind, source, path string) (any, error) {
	switch kind {
	case "whatsapp":
		return whatsapp.Import(ctx, d.st, d.blobs, d.archiveDir, path)
	case "eml":
		return eml.ImportEmlPath(ctx, d.st, d.blobs, d.archiveDir, source, path)
	case "mbox":
		return eml.ImportMbox(ctx, d.st, d.blobs, d.archiveDir, source, path)
	case "discord":
		return discord.Import(ctx, d.st, d.archiveDir, path)
	case "linkedin":
		return linkedin.Import(ctx, d.st, d.archiveDir, path)
	case "youtube":
		return youtube.Import(ctx, d.st, d.archiveDir, path)
	case "chatgpt":
		return aichat.ImportChatGPT(ctx, d.st, d.blobs, d.archiveDir, path)
	case "claude":
		return aichat.ImportClaude(ctx, d.st, d.archiveDir, path)
	case "json":
		input, err := readInput(path)
		if err != nil {
			return nil, err
		}
		rawRef, err := archiveJSON(d.archiveDir, path, input)
		if err != nil {
			return nil, err
		}
		return generic.Import(ctx, d.st, d.blobs, source, rawRef, input, time.Now(), true)
	}
	return nil, fmt.Errorf("unknown import source %q (%s)", kind, strings.Join(inbox.Kinds, ", "))
}

func archiveJSON(archiveDir, path string, input []byte) (string, error) {
	if path == "-" {
		sum := sha256.Sum256(input)
		return archive.Write(archiveDir, "json", fmt.Sprintf("stdin-%x.json", sum[:6]), input)
	}
	return archive.Copy(archiveDir, "json", path)
}

type importInboxCmd struct {
	JSON      bool `help:"JSON output."`
	NoExtract bool `help:"Skip reading text out of attachments."`
}

func (c *importInboxCmd) Run(ctx context.Context) error {
	if client.FromEnv() != nil {
		return fmt.Errorf("import inbox reads the server's own drop zone; run it there, not through BANK_URL")
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	inboxDir := filepath.Join(dataDir(), "inbox")
	res, sweepErr := inbox.Sweep(ctx, inboxDir, func(ctx context.Context, kind, path string) (inbox.Outcome, error) {
		out, err := importLocal(ctx, d, kind, inboxSource(kind), path)
		if err != nil {
			return inbox.Outcome{}, err
		}
		return importOutcome(out), nil
	})
	if err := extractAfterImport(ctx, blobtext.Local{Store: d.st, Blobs: d.blobs}, c.NoExtract); err != nil {
		return err
	}
	if c.JSON {
		if err := printJSON(res); err != nil {
			return err
		}
		return sweepErr
	}
	for _, warning := range res.Warnings {
		fmt.Fprintf(os.Stderr, "bank: %s\n", warning)
	}
	if len(res.Files) == 0 {
		fmt.Printf("inbox is empty (%s/<%s>/)\n", inboxDir, strings.Join(inbox.Kinds, "|"))
		return sweepErr
	}
	for _, f := range res.Files {
		fmt.Printf("%-10s %-9s %s", f.Kind, f.Disposition, filepath.Base(f.Path))
		if f.Detail != "" {
			fmt.Printf("  (%s)", f.Detail)
		}
		fmt.Println()
	}
	fmt.Printf("%d imported, %d already known, %d rejected, %d failed\n",
		res.Imported, res.Duplicates, res.Rejected, res.Failed)
	if res.Settling > 0 {
		fmt.Printf("%d entr(ies) modified moments ago were left for the next sweep\n", res.Settling)
	}
	return sweepErr
}

// reimportKinds are the sources bank reimport can replay: their kind and
// source coincide, their importer reads back the same file shape it archived,
// and the original filename is recoverable from the archived name. Mail is
// absent deliberately — gmail archives one .eml per synced message, and
// eml/mbox archives live under a --source (proton, gmail, ...) that does not
// determine the kind. `reimport mbox --heal-bodies` is the one pass that does
// re-read mail, and it repairs one column instead of replaying an import.
var reimportKinds = []string{"chatgpt", "claude", "discord", "whatsapp", "linkedin", "youtube"}

// healBodiesKind is the pseudo-kind that reaches the mail healer. It is a kind
// rather than a command of its own because it is the same operation from the
// operator's side: read what was archived, apply what the code learned since.
const healBodiesKind = "mbox"

// reimportCmd replays every archived raw input of one source through the
// current importer. Imports are idempotent, so the only visible effect is
// whatever today's importer does better than the one that first read the file
// — messages it used to drop, threads it used to key wrong.
type reimportCmd struct {
	Kind       string `arg:"" help:"chatgpt, claude, discord, whatsapp, linkedin, youtube, or mbox with --heal-bodies."`
	NoExtract  bool   `help:"Skip reading text out of attachments."`
	JSON       bool   `help:"JSON output."`
	HealBodies bool   `help:"Re-read archived mail and replace stub bodies today's parser reads better (mbox only)."`
	Apply      bool   `help:"Write the healed bodies; without it, --heal-bodies is a dry run."`
	Source     string `help:"Mail source for --heal-bodies (default gmail)."`
}

func (c *reimportCmd) Run(ctx context.Context) error {
	kind := c.Kind
	if client.FromEnv() != nil {
		return fmt.Errorf("reimport replays the server's own archive; run it there, not through BANK_URL")
	}
	if kind == healBodiesKind {
		if !c.HealBodies {
			return fmt.Errorf("mail is not replayed wholesale; `bank reimport mbox --heal-bodies` re-reads it to replace stub bodies today's parser reads better")
		}
		return healMailBodies(ctx, c.Source, c.Apply, c.JSON)
	}
	if c.HealBodies || c.Apply || c.Source != "" {
		return fmt.Errorf("--heal-bodies, --apply and --source belong to `bank reimport %s`", healBodiesKind)
	}
	if !slices.Contains(reimportKinds, kind) {
		return fmt.Errorf("cannot replay %q; reimport covers %s", kind, strings.Join(reimportKinds, ", "))
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	entries, err := archive.List(d.archiveDir, kind)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Printf("nothing archived under %s\n", filepath.Join(d.archiveDir, kind))
		return nil
	}
	staging, err := os.MkdirTemp(stagingDir(), "reimport-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)

	type replayed struct {
		Ref    string `json:"ref"`
		Result any    `json:"result,omitempty"`
		Error  string `json:"error,omitempty"`
	}
	var out []replayed
	var failed int
	for i, e := range entries {
		// One directory per input: original names repeat across exports
		// (every merged ChatGPT export stages as conversations.json).
		sub := filepath.Join(staging, strconv.Itoa(i))
		if err := os.Mkdir(sub, 0o700); err != nil {
			return err
		}
		p, err := archive.Stage(d.archiveDir, e, sub)
		if err != nil {
			return fmt.Errorf("stage %s: %w", e.Ref, err)
		}
		res, err := importLocal(ctx, d, kind, "", p)
		if err != nil {
			// A file today's importer cannot parse must not cost the rest of
			// the replay; anything operational (database, archive) still
			// aborts, as one failure would just repeat for every input.
			if fail.IsOp(err) {
				return fmt.Errorf("%s: %w", e.Ref, err)
			}
			failed++
			out = append(out, replayed{Ref: e.Ref, Error: err.Error()})
			fmt.Fprintf(os.Stderr, "bank: skipping %s: %v\n", e.Ref, err)
			continue
		}
		out = append(out, replayed{Ref: e.Ref, Result: res})
		if !c.JSON {
			printImportResult(kind, "", e.Ref, res)
		}
	}
	if c.JSON {
		if err := printJSON(out); err != nil {
			return err
		}
	}
	if err := extractAfterImport(ctx, blobtext.Local{Store: d.st, Blobs: d.blobs}, c.NoExtract); err != nil {
		return err
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d archived inputs failed to replay", failed, len(entries))
	}
	return nil
}

// healMailBodies re-reads one mail source's archived raws and replaces bodies
// the current parser reads better than the one that first imported them. It
// reports without writing unless apply is set: the write is the one exception
// to "a re-import never overwrites a body", so it should be read before it is
// taken.
func healMailBodies(ctx context.Context, source string, apply, asJSON bool) error {
	if source == "" {
		source = defaultSource(healBodiesKind)
	}
	if err := archive.ValidSource(source); err != nil {
		return err
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	verb := "would heal"
	if apply {
		verb = "healed"
	}
	heals := []eml.BodyHeal{}
	res, err := eml.HealBodies(ctx, d.st, d.archiveDir, source, apply, func(h eml.BodyHeal) {
		if asJSON {
			heals = append(heals, h)
			return
		}
		fmt.Printf("%s: id=%d ref=%s subject=%q stored=%d reparsed=%d\n",
			verb, h.ID, h.Ref, h.Subject, h.Stored, h.Reparsed)
	})
	if err != nil {
		return err
	}
	if asJSON {
		return printJSON(struct {
			eml.HealResult
			Heals []eml.BodyHeal `json:"heals"`
		}{res, heals})
	}
	printHealResult(source, res)
	return nil
}

func printHealResult(source string, res eml.HealResult) {
	outcome := "to heal"
	if res.Applied {
		outcome = "healed"
	}
	fmt.Printf("%s: %s, %s read, %d still archived, %d %s",
		source, plural(res.Files, "raw file"), plural(res.Messages, "message"), res.Matched, res.Healed, outcome)
	if res.Rejected > 0 {
		fmt.Printf(", %d unreadable", res.Rejected)
	}
	fmt.Println()
	if !res.Applied && res.Healed > 0 {
		fmt.Println("dry run — pass --apply to write these bodies")
	}
}

// importOutcome reduces an importer's result to the counts the sweep uses to
// pick a disposition.
func importOutcome(res any) inbox.Outcome {
	switch r := res.(type) {
	case mediaimport.Result:
		return inbox.Outcome{Inserted: r.Items + r.Activity + r.Collections + r.Files + r.Pages, Duplicates: r.Duplicates, Rejected: r.Skipped, Result: r}
	case eml.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Rejected: r.Rejected, Result: r}
	case whatsapp.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Result: r}
	case discord.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Rejected: len(r.FailedChannels), Result: r}
	case linkedin.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Result: r}
	case youtube.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Result: r}
	case aichat.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Result: r}
	case generic.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Rejected: r.Rejected, Result: r}
	}
	return inbox.Outcome{Result: res}
}

func printImportResult(kind, source, path string, res any) {
	switch r := res.(type) {
	case mediaimport.Result:
		fmt.Printf("%s (%s): %d items, %d activity records, %d collections, %d files, %d pages, %d already known, %d skipped\n", kind, filepath.Base(path), r.Items, r.Activity, r.Collections, r.Files, r.Pages, r.Duplicates, r.Skipped)
		for _, diagnostic := range r.Diagnostics {
			fmt.Fprintln(os.Stderr, "bank: "+diagnostic)
		}
	case eml.Result:
		printEmlResult(source, path, r)
	case whatsapp.Result:
		printWhatsAppResult(r)
	case discord.Result:
		printDiscordResult(r)
	case linkedin.Result:
		printLinkedInResult(r)
	case youtube.Result:
		printYouTubeResult(r)
	case aichat.Result:
		printAIChatResult(kind, path, r)
	case generic.Result:
		printGenericResult(r)
	}
}

func printEmlResult(source, path string, res eml.Result) {
	fmt.Printf("%s (%s): %d new, %d already known, %d attachments", source, filepath.Base(path), res.Inserted, res.Duplicates, res.Attachments)
	if res.Healed > 0 {
		fmt.Printf(" (%d recovered)", res.Healed)
	}
	if res.Rejected > 0 {
		fmt.Printf(", %d rejected as malformed", res.Rejected)
	}
	if res.Damaged > 0 {
		fmt.Printf(", %d with damaged MIME structure", res.Damaged)
	}
	fmt.Println()
	for _, w := range res.Warnings {
		fmt.Fprintf(os.Stderr, "bank: %s\n", w)
	}
}

func printWhatsAppResult(res whatsapp.Result) {
	fmt.Printf("%s: %d new, %d already known, %d attachments", res.Thread, res.Inserted, res.Duplicates, res.Attachments)
	if res.MissingMedia > 0 {
		fmt.Printf(", %d media files referenced but not in export", res.MissingMedia)
	}
	fmt.Println()
}

func printDiscordResult(res discord.Result) {
	fmt.Printf("discord: %d channels, %d new, %d already known, %d empty rows skipped",
		res.Channels, res.Inserted, res.Duplicates, res.Skipped)
	if len(res.FailedChannels) > 0 {
		fmt.Printf(", %d channels unreadable (%s)", len(res.FailedChannels), strings.Join(res.FailedChannels, ", "))
	}
	fmt.Println()
}

func printLinkedInResult(res linkedin.Result) {
	fmt.Printf("linkedin: %d new, %d already known, %d empty rows skipped\n",
		res.Inserted, res.Duplicates, res.Skipped)
}

func printYouTubeResult(res youtube.Result) {
	fmt.Printf("youtube: %d channels, %d new, %d already known, %d records skipped",
		res.Channels, res.Inserted, res.Duplicates, res.Skipped)
	if res.Ads > 0 {
		fmt.Printf(", %d ad impressions dropped", res.Ads)
	}
	fmt.Println()
}

// printAIChatResult names the file it is reporting on, so a sharded export does
// not print a wall of indistinguishable lines, and reconciles the conversations
// found in the input against the ones that made it in — a gap between the two
// is the only visible sign of silently dropped conversations.
func printAIChatResult(kind, path string, res aichat.Result) {
	found := res.Conversations + res.EmptyConversations
	fmt.Printf("%s (%s): %d conversations found, %d imported, %d new, %d already known, %d skipped",
		kind, filepath.Base(path), found, res.Conversations, res.Inserted, res.Duplicates, res.Skipped)
	if res.EmptyConversations > 0 {
		fmt.Printf(", %d conversations without importable messages", res.EmptyConversations)
	}
	if res.Attachments > 0 || res.MissingMedia > 0 {
		fmt.Printf(", %d attachments (%d missing from export)", res.Attachments, res.MissingMedia)
	}
	fmt.Println()
}

func printGenericResult(res generic.Result) {
	fmt.Printf("json: %d new, %d already known, %d attachments", res.Inserted, res.Duplicates, res.Attachments)
	if res.Healed > 0 {
		fmt.Printf(" (%d recovered)", res.Healed)
	}
	if res.Rejected > 0 {
		fmt.Printf(", %d entries rejected", res.Rejected)
	}
	fmt.Println()
}

func importRemote(ctx context.Context, c *client.Client, kind, source string, paths []string) error {
	for _, path := range paths {
		if kind == "json" {
			input, err := readInput(path)
			if err != nil {
				return err
			}
			res, err := c.ImportJSON(ctx, source, input)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			printGenericResult(res)
			continue
		}
		files, err := remoteImportFiles(kind, path)
		if err != nil {
			return err
		}
		for _, f := range files {
			if err := importRemoteFile(ctx, c, kind, source, f); err != nil {
				return fmt.Errorf("%s: %w", f, err)
			}
		}
	}
	return nil
}

func remoteImportFiles(kind, path string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return []string{path}, nil
	}
	if kind != "eml" {
		return nil, fmt.Errorf("%s: remote import of %s takes a file, not a directory", path, kind)
	}
	var out []string
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".eml") {
			return err
		}
		out = append(out, p)
		return nil
	})
	return out, err
}

func importRemoteFile(ctx context.Context, c *client.Client, kind, source, path string) error {
	switch kind {
	case "whatsapp":
		res, err := client.ImportFile[whatsapp.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printWhatsAppResult(res)
	case "eml", "mbox":
		res, err := client.ImportFile[eml.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printEmlResult(source, path, res)
	case "discord":
		res, err := client.ImportFile[discord.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printDiscordResult(res)
	case "linkedin":
		res, err := client.ImportFile[linkedin.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printLinkedInResult(res)
	case "youtube":
		res, err := client.ImportFile[youtube.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printYouTubeResult(res)
	case "chatgpt", "claude":
		res, err := client.ImportFile[aichat.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printAIChatResult(kind, path, res)
	default:
		return fmt.Errorf("unknown import source %q (%s)", kind, strings.Join(inbox.Kinds, ", "))
	}
	return nil
}

// readInput reads a file, or stdin when path is "-".
func readInput(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}
