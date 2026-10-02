// tracker is the browsing-memory service: events and HTML captures in from
// the browser extension, extracted records and attention analytics out.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/aquitano/aqt/apps/tracker/internal/auth"
	"github.com/aquitano/aqt/apps/tracker/internal/blob"
	"github.com/aquitano/aqt/apps/tracker/internal/client"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	_ "github.com/aquitano/aqt/apps/tracker/internal/extractor/all"
	"github.com/aquitano/aqt/apps/tracker/internal/ingest"
	"github.com/aquitano/aqt/apps/tracker/internal/metrics"
	"github.com/aquitano/aqt/apps/tracker/internal/processor"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/urlnorm"
)

const usage = `tracker — browsing memory

Usage:
  tracker serve [--listen 127.0.0.1:8490] [--workers 3]   HTTP ingest plus in-process extraction workers
  tracker migrate                                         apply pending migrations and exit
  tracker reprocess [--extractor name] [--failed] [--all] re-queue extraction
                                                          (default: every capture under the current version;
                                                          --failed: retry failed jobs; --all: wipe and rebuild
                                                          records and derivations from the raw blobs)
  tracker blob <hash-or-url>                              write a stored capture's HTML to stdout: a blob hash,
                                                          or the most recent capture of a page
  tracker login                                           device-code sign in against the OIDC issuer
  tracker logout                                          forget the stored token
  tracker stats [--json]                                  table counts, blob sizes, queue and record totals
  tracker search [--extractor name] [--limit n] [--json] <query>
                                                          BM25 search over extracted records, with each
                                                          hit's visits
  tracker show [--json] <record-id>                       one record in full: title, URL, visits, search text
  tracker visits [--json] <url>                           how often and how long a page was open, captured or not
  tracker time [--since 24h] [--until when] [--by host|app|category] [--json]
                                                          active time per site, desktop app or category;
                                                          since and until take a duration back from now
                                                          (90m, 24h, 7d) or a local date (2026-10-01)
  tracker forget <url> | --host <host>                    delete everything recorded for a page, or a host and
                                                          its subdomains; backups keep it until they rotate out

stats, search, show, visits, time and forget go over HTTP, so they work
against a tracker on another machine; serve, migrate, reprocess and blob need
the database itself.

Environment:
  TRACKER_DATABASE_URL   default postgres://tracker:tracker@127.0.0.1:5435/tracker?sslmode=disable
  TRACKER_LISTEN         default 127.0.0.1:8490
  TRACKER_WORKERS        default 3
  TRACKER_LOG_LEVEL      debug | info | warn | error (default info)
  TRACKER_SERVER_URL     default http://127.0.0.1:8490, what the CLI talks to
  TRACKER_OIDC_ISSUER    unset, which means no authentication on either side
  TRACKER_OIDC_AUDIENCE  audience serve requires in a token, usually the client id
  TRACKER_OIDC_CLIENT_ID client id the CLI signs in as
  TRACKER_TOKEN_PATH     default <user config dir>/tracker/token.json
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	ctx := context.Background()
	var err error
	switch os.Args[1] {
	case "serve":
		err = cmdServe(ctx, os.Args[2:])
	case "migrate":
		err = cmdMigrate(ctx)
	case "reprocess":
		err = cmdReprocess(ctx, os.Args[2:])
	case "blob":
		err = cmdBlob(ctx, os.Args[2:])
	case "login":
		err = cmdLogin(ctx)
	case "logout":
		err = cmdLogout()
	case "stats":
		err = cmdStats(ctx, os.Args[2:])
	case "search":
		err = cmdSearch(ctx, os.Args[2:])
	case "show":
		err = cmdShow(ctx, os.Args[2:])
	case "visits":
		err = cmdVisits(ctx, os.Args[2:])
	case "time":
		err = cmdTime(ctx, os.Args[2:])
	case "forget":
		err = cmdForget(ctx, os.Args[2:])
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tracker:", err)
		os.Exit(1)
	}
}

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func databaseURL() string {
	return env("TRACKER_DATABASE_URL", "postgres://tracker:tracker@127.0.0.1:5435/tracker?sslmode=disable")
}

func logger() *slog.Logger {
	var level slog.Level
	if err := level.UnmarshalText([]byte(env("TRACKER_LOG_LEVEL", "info"))); err != nil {
		level = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
}

func cmdServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", env("TRACKER_LISTEN", "127.0.0.1:8490"), "")
	defaultWorkers, err := strconv.Atoi(env("TRACKER_WORKERS", "3"))
	if err != nil {
		return fmt.Errorf("TRACKER_WORKERS: %w", err)
	}
	workers := fs.Int("workers", defaultWorkers, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *workers < 1 {
		return errors.New("workers must be at least 1")
	}
	log := logger()
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	authenticator, err := auth.New(ctx, auth.Config{
		Issuer:   os.Getenv("TRACKER_OIDC_ISSUER"),
		Audience: os.Getenv("TRACKER_OIDC_AUDIENCE"),
	})
	if err != nil {
		return err
	}
	st, err := store.Open(ctx, databaseURL())
	if err != nil {
		return err
	}
	defer st.Close()
	queued, err := st.QueueCaptures(ctx, extractorVersions(""))
	if err != nil {
		return fmt.Errorf("queue captures: %w", err)
	}
	m := metrics.New()
	proc := processor.New(st, m, log, *workers)
	srv := &http.Server{
		Addr:              *listen,
		Handler:           ingest.New(st, m, log, proc.Wake, authenticator).Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}

	go m.Refresh(ctx, st, 30*time.Second, func(err error) { log.Warn("metrics refresh", "err", err) })
	workersDone := make(chan struct{})
	go func() {
		defer close(workersDone)
		proc.Run(ctx)
	}()
	// ListenAndServe returns as soon as Shutdown starts, not when it has
	// drained, so the store must outlive this rather than that.
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Info("serving", "listen", *listen, "workers", *workers,
		"extractors", len(extractor.All()), "queued", queued, "auth", authenticator.Enabled())
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		stop()
		<-workersDone
		return err
	}
	<-drained
	<-workersDone
	log.Info("stopped")
	return nil
}

func cmdMigrate(ctx context.Context) error {
	st, err := store.Open(ctx, databaseURL())
	if err != nil {
		return err
	}
	fmt.Println("migrations applied")
	return st.Close()
}

func cmdReprocess(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("reprocess", flag.ExitOnError)
	name := fs.String("extractor", "", "")
	failed := fs.Bool("failed", false, "")
	all := fs.Bool("all", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	targets := extractorVersions(*name)
	if len(targets) == 0 {
		return fmt.Errorf("no registered extractor matches %q", *name)
	}
	st, err := store.Open(ctx, databaseURL())
	if err != nil {
		return err
	}
	defer st.Close()
	n, err := st.Reprocess(ctx, store.ReprocessOpts{Targets: targets, Failed: *failed, All: *all})
	if err != nil {
		return err
	}
	fmt.Printf("queued %d derivations; a running 'tracker serve' picks them up\n", n)
	return nil
}

func cmdBlob(ctx context.Context, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: tracker blob <hash-or-url>")
	}
	st, err := store.Open(ctx, databaseURL())
	if err != nil {
		return err
	}
	defer st.Close()
	hash, err := blobHash(ctx, st, args[0])
	if err != nil {
		return err
	}
	b, err := st.LoadBlob(ctx, hash)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no blob %x", hash)
	}
	if err != nil {
		return err
	}
	html, err := blob.Decompress(b.Payload)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(html)
	return err
}

// blobHash reads 64 hex characters as a blob hash and anything else as a
// page URL, normalised the way ingest stores it.
func blobHash(ctx context.Context, st *store.Store, ref string) ([]byte, error) {
	if hash, err := hex.DecodeString(ref); err == nil && len(hash) == 32 {
		return hash, nil
	}
	normalized, _, err := urlnorm.Normalize(ref)
	if err != nil {
		return nil, fmt.Errorf("%q is neither a 64-character blob hash nor an http(s) url", ref)
	}
	hash, err := st.LatestCaptureHash(ctx, urlnorm.Hash(normalized))
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("no capture of %s", normalized)
	}
	return hash, err
}

// extractorVersions lists every registered extractor at its current version,
// or only the one name picks.
func extractorVersions(name string) []store.ExtractorVersion {
	var targets []store.ExtractorVersion
	for _, e := range extractor.All() {
		r := e.Rule()
		if name == "" || name == r.Extractor {
			targets = append(targets, store.ExtractorVersion{Name: r.Extractor, Version: r.Version})
		}
	}
	return targets
}

func clientConfig() (client.Config, error) {
	path := os.Getenv("TRACKER_TOKEN_PATH")
	if path == "" {
		var err error
		if path, err = client.DefaultTokenPath(); err != nil {
			return client.Config{}, err
		}
	}
	return client.Config{
		ServerURL: env("TRACKER_SERVER_URL", "http://127.0.0.1:8490"),
		Issuer:    os.Getenv("TRACKER_OIDC_ISSUER"),
		ClientID:  os.Getenv("TRACKER_OIDC_CLIENT_ID"),
		TokenPath: path,
	}, nil
}

func newClient(ctx context.Context) (*client.Client, error) {
	cfg, err := clientConfig()
	if err != nil {
		return nil, err
	}
	return client.New(ctx, cfg)
}

func cmdLogin(ctx context.Context) error {
	cfg, err := clientConfig()
	if err != nil {
		return err
	}
	return client.Login(ctx, cfg, os.Stdout)
}

func cmdLogout() error {
	cfg, err := clientConfig()
	if err != nil {
		return err
	}
	if err := client.Logout(cfg); err != nil {
		return err
	}
	fmt.Println("signed out")
	return nil
}

func cmdStats(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := newClient(ctx)
	if err != nil {
		return err
	}
	stats, err := c.Stats(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(stats)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 8, 2, ' ', 0)
	fmt.Fprintf(w, "urls\t%d\npage views\t%d\nactivity spans\t%d\nactive time\t%s\n",
		stats.URLs, stats.PageViews, stats.ActivitySpans, (time.Duration(stats.ActiveSeconds) * time.Second).Round(time.Minute))
	fmt.Fprintf(w, "blobs\t%d\t(%s raw, %s stored)\ncaptures\t%d\n",
		stats.Blobs, humanBytes(stats.BlobRawBytes), humanBytes(stats.BlobStoredBytes), stats.Captures)
	for _, status := range []string{store.StatusPending, store.StatusRunning, store.StatusDone, store.StatusFailed} {
		fmt.Fprintf(w, "derivations %s\t%d\n", status, stats.Derivations[status])
	}
	for name, n := range stats.Records {
		fmt.Fprintf(w, "records %s\t%d\n", name, n)
	}
	return w.Flush()
}

func cmdSearch(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	name := fs.String("extractor", "", "")
	limit := fs.Int("limit", 20, "")
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	query := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if query == "" {
		return errors.New("usage: tracker search [--extractor name] [--limit n] [--json] <query>")
	}
	c, err := newClient(ctx)
	if err != nil {
		return err
	}
	hits, err := c.Search(ctx, store.SearchOpts{Query: query, Extractor: *name, Limit: *limit})
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(hits)
	}
	for _, h := range hits {
		fmt.Printf("%d  [%s]  %s\n    %s\n    %s\n", h.ID, h.Extractor, h.Title, h.CanonicalURL, describeVisits(h.Visits))
		if h.Snippet != "" {
			fmt.Printf("    %s\n", h.Snippet)
		}
	}
	if len(hits) == 0 {
		fmt.Println("no results")
	}
	return nil
}

func cmdShow(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("show", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	id, err := strconv.ParseInt(fs.Arg(0), 10, 64)
	if fs.NArg() != 1 || err != nil {
		return errors.New("usage: tracker show [--json] <record-id>")
	}
	c, err := newClient(ctx)
	if err != nil {
		return err
	}
	rec, err := c.Record(ctx, id)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(rec)
	}
	fmt.Printf("%s\n%s\n[%s]  %s\n\n%s\n", rec.Title, rec.CanonicalURL, rec.Extractor, describeVisits(rec.Visits), rec.SearchText)
	return nil
}

func cmdVisits(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("visits", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: tracker visits [--json] <url>")
	}
	c, err := newClient(ctx)
	if err != nil {
		return err
	}
	page, err := c.Visits(ctx, fs.Arg(0))
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(page)
	}
	fmt.Printf("%s\n%s\n", page.URL, describeVisits(page.Visits))
	return nil
}

func cmdTime(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("time", flag.ExitOnError)
	since := fs.String("since", "24h", "")
	until := fs.String("until", "0s", "")
	by := fs.String("by", "host", "")
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("usage: tracker time [--since 24h] [--until when] [--by host|app|category] [--json]")
	}
	now := time.Now()
	from, err := pointInTime(*since, now)
	if err != nil {
		return err
	}
	to, err := pointInTime(*until, now)
	if err != nil {
		return err
	}
	c, err := newClient(ctx)
	if err != nil {
		return err
	}
	rows, err := c.Time(ctx, store.TimeOpts{From: from, To: to, By: *by})
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(rows)
	}
	if len(rows) == 0 {
		fmt.Println("no active time")
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 8, 2, ' ', 0)
	for _, r := range rows {
		fmt.Fprintf(w, "%s\t%s\n", r.Key, activeTime(r.ActiveSeconds))
	}
	return w.Flush()
}

func cmdForget(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("forget", flag.ExitOnError)
	host := fs.String("host", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	target := store.ForgetTarget{Host: *host}
	switch {
	case *host == "" && fs.NArg() == 1:
		target.URL = fs.Arg(0)
	case *host == "" || fs.NArg() != 0:
		return errors.New("usage: tracker forget <url> | tracker forget --host <host>")
	}
	c, err := newClient(ctx)
	if err != nil {
		return err
	}
	f, err := c.Forget(ctx, target)
	if err != nil {
		return err
	}
	fmt.Printf("forgot %d page views, %d spans, %d captures, %d blobs, %d records\n",
		f.PageViews, f.Spans, f.Captures, f.Blobs, f.Records)
	return nil
}

// pointInTime reads a duration back from now (90m, 24h, 7d) or a date, which
// means its local midnight.
func pointInTime(s string, now time.Time) (time.Time, error) {
	if days, ok := strings.CutSuffix(s, "d"); ok {
		if n, err := strconv.Atoi(days); err == nil {
			return now.AddDate(0, 0, -n), nil
		}
	}
	if d, err := time.ParseDuration(s); err == nil {
		return now.Add(-d), nil
	}
	if t, err := time.ParseInLocation(time.DateOnly, s, time.Local); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("%q is neither a duration like 24h or 7d nor a date like 2026-10-01", s)
}

func describeVisits(v store.Visits) string {
	if v.LastAt == nil {
		return "no visits on file"
	}
	return fmt.Sprintf("visited %d×, last %s, %s", v.Count, v.LastAt.Local().Format(time.DateOnly), activeTime(v.ActiveSeconds))
}

func activeTime(seconds int64) string {
	switch minutes := (seconds + 30) / 60; {
	case minutes == 0:
		return "<1 min"
	case minutes < 60:
		return fmt.Sprintf("%d min", minutes)
	default:
		return fmt.Sprintf("%d h %d min", minutes/60, minutes%60)
	}
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
