package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/scan"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func cmdScan(ctx context.Context, args []string) error {
	flagArgs, pos := interspersed(args, map[string]bool{"no-hash": true, "new-volume": true, "json": true})
	fs := flag.NewFlagSet("scan", flag.ExitOnError)
	configPath := fs.String("config", "", "")
	noHash := fs.Bool("no-hash", false, "")
	volume := fs.String("volume", "", "")
	newVolume := fs.Bool("new-volume", false, "")
	logLevel := fs.String("log-level", "info", "")
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(flagArgs)
	if len(pos) != 1 {
		return fmt.Errorf("scan needs one folder: %w", errUsage)
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(*logLevel)); err != nil {
		return fmt.Errorf("--log-level: %w", err)
	}
	cfg, _, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()

	log, logPath, closeLog := openScanLog(level)
	defer closeLog()
	log.Info("attic started", "build", buildRevision(), "args", os.Args[1:], "pid", os.Getpid())
	p := &progressLine{tty: stderrIsTerminal(), started: time.Now()}
	res, err := scan.Run(ctx, st, scan.Options{
		Path: pos[0], Config: cfg, NoHash: *noHash, VolumeID: *volume, NewVolume: *newVolume, Progress: p.update, Log: log,
	})
	p.clear()
	if res.ScanID == 0 {
		if err != nil {
			log.Error("scan did not start", "err", err)
		}
		return err
	}
	if *asJSON {
		if jerr := printJSON(struct {
			scan.Result
			Log string `json:"log,omitempty"`
		}{res, logPath}); jerr != nil {
			return jerr
		}
		return err
	}
	root := res.Root
	if root == "" {
		root = "/"
	}
	c := res.Counts
	fmt.Printf("%s (%s) %s: %s in %s, scan %d\n", res.Volume.Label, res.Volume.MountPath, root, res.Status,
		res.Elapsed.Round(time.Second), res.ScanID)
	fmt.Printf("  %s entries listed, %s new or changed, %s missing, %s skipped (attic skips --scan %d)\n",
		count(c.Listed), count(c.Written), count(c.Missing), count(c.Skipped), res.ScanID)
	fmt.Printf("  %s files hashed (%s), %s already known; %s left to hash\n",
		count(c.Hashed), humanBytes(c.HashedBytes), count(c.Duplicates), count(res.Pending))
	if c.Archives > 0 {
		fmt.Printf("  %s archives listed, %s members inside\n", count(c.Archives), count(c.Members))
	}
	if c.Texts > 0 {
		fmt.Printf("  %s documents read, %s characters of text\n", count(c.Texts), count(c.TextChars))
	}
	if c.Metadata > 0 {
		fmt.Printf("  %s files read for metadata\n", count(c.Metadata))
	}
	fmt.Printf("  took %s\n", phaseSummary(res.Phases, c.HashedBytes))
	printSlow("slowest archives", res.SlowArchives, res.Volume.MountPath)
	printSlow("slowest documents", res.SlowDocuments, res.Volume.MountPath)
	if logPath != "" {
		fmt.Printf("  log %s\n", logPath)
	}
	if res.Status == "interrupted" {
		fmt.Println("  run the same command again to continue; finished work is kept")
	}
	return err
}

// phaseSummary names the phases that ran and how long each took, with the
// hashing rate, the number a slow disk shows in first.
func phaseSummary(ph store.PhaseTimes, hashed int64) string {
	var parts []string
	add := func(name string, d time.Duration, extra string) {
		if d > 0 {
			parts = append(parts, name+" "+took(d)+extra)
		}
	}
	add("walk", ph.Walk, "")
	rate := ""
	if s := ph.Hash.Seconds(); s >= 1 && hashed > 0 {
		rate = fmt.Sprintf(" (%s/s)", humanBytes(int64(float64(hashed)/s)))
	}
	add("hash", ph.Hash, rate)
	add("archives", ph.Archives, "")
	add("documents", ph.Text, "")
	add("metadata", ph.Metadata, "")
	// Scans from before phase times were kept have none.
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, ", ")
}

func printSlow(title string, slow []scan.Slow, mount string) {
	// Under a second is not worth a line.
	if len(slow) == 0 || slow[0].Took < time.Second {
		return
	}
	fmt.Printf("  %s:\n", title)
	for _, s := range slow {
		if s.Took >= time.Second {
			fmt.Printf("    %8s  %s\n", s.Took.Round(time.Second), filepath.Join(mount, filepath.FromSlash(strings.TrimPrefix(s.Path, "/"))))
		}
	}
}

// openScanLog writes this scan's structured log to a JSON-lines file under
// <UserCacheDir>/attic/logs (%LOCALAPPDATA% on Windows), named by when it
// started and by the process, so two scans of two disks never share one. A
// log that cannot be created costs the log, not the scan.
func openScanLog(level slog.Level) (*slog.Logger, string, func()) {
	dir, err := os.UserCacheDir()
	if err == nil {
		dir = filepath.Join(dir, "attic", "logs")
		err = os.MkdirAll(dir, 0o755)
	}
	var f *os.File
	if err == nil {
		removeOldLogs(dir)
		name := fmt.Sprintf("scan-%s-%d.jsonl", time.Now().Format("20060102-150405"), os.Getpid())
		f, err = os.Create(filepath.Join(dir, name))
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "attic: no scan log: %v\n", err)
		return slog.New(slog.DiscardHandler), "", func() {}
	}
	return slog.New(slog.NewJSONHandler(f, &slog.HandlerOptions{Level: level})), f.Name(), func() { f.Close() }
}

// buildRevision names the commit the binary was built from, for the log.
func buildRevision() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	rev, dirty := "", ""
	for _, s := range info.Settings {
		switch {
		case s.Key == "vcs.revision":
			rev = s.Value[:min(len(s.Value), 12)]
		case s.Key == "vcs.modified" && s.Value == "true":
			dirty = "+dirty"
		}
	}
	return rev + dirty
}

// progressLine redraws one status line on a terminal and prints one every
// 30 seconds anywhere else, so a log or an agent is not flooded.
type progressLine struct {
	tty       bool
	started   time.Time
	hashStart time.Time
	last      time.Time
	width     int
}

func (p *progressLine) update(pr scan.Progress) {
	// The rate needs the moment hashing began, even when that update is not
	// printed.
	if pr.Phase == "hash" && p.hashStart.IsZero() {
		p.hashStart = time.Now()
	}
	if !p.tty && time.Since(p.last) < 30*time.Second {
		return
	}
	p.last = time.Now()
	var line string
	switch pr.Phase {
	case "walk":
		line = fmt.Sprintf("walking: %s folders, %s entries, %s new or changed, %s skipped",
			count(pr.Dirs), count(pr.Listed), count(pr.Written), count(pr.Skipped))
	case "hash":
		line = fmt.Sprintf("hashing: %s of %s files, %s of %s", count(pr.Hashed), count(pr.HashFiles),
			humanBytes(pr.HashedBytes), humanBytes(pr.HashBytes))
		if elapsed := time.Since(p.hashStart).Seconds(); elapsed > 5 && pr.HashedBytes > 0 {
			rate := float64(pr.HashedBytes) / elapsed
			left := time.Duration(float64(pr.HashBytes-pr.HashedBytes)/rate) * time.Second
			line += fmt.Sprintf(", %s/s, about %s left", humanBytes(int64(rate)), left.Round(time.Minute))
		}
	case "metadata":
		line = fmt.Sprintf("metadata: %s of %s; %s", count(pr.Done), count(pr.Total), pr.Current)
	case "archives":
		line = fmt.Sprintf("archives: %s of %s, %s members; %s", count(pr.Done), count(pr.Total),
			count(pr.Members), path.Base(pr.Current))
	case "text":
		line = fmt.Sprintf("documents: %s of %s, %s characters; %s", count(pr.Done), count(pr.Total),
			count(pr.TextChars), path.Base(pr.Current))
	}
	if !p.tty {
		fmt.Fprintln(os.Stderr, line)
		return
	}
	pad := max(p.width-len(line), 0)
	fmt.Fprintf(os.Stderr, "\r%s%s", line, strings.Repeat(" ", pad))
	p.width = len(line)
}

func (p *progressLine) clear() {
	if p.tty && p.width > 0 {
		fmt.Fprintf(os.Stderr, "\r%s\r", strings.Repeat(" ", p.width))
	}
}

// removeOldLogs keeps the logs folder from growing without end: a debug log
// of a whole disk runs to a hundred megabytes.
func removeOldLogs(dir string) {
	old, _ := filepath.Glob(filepath.Join(dir, "scan-*.jsonl"))
	for _, p := range old {
		if fi, err := os.Stat(p); err == nil && time.Since(fi.ModTime()) > 90*24*time.Hour {
			_ = os.Remove(p)
		}
	}
}

// took rounds a phase's time for the summary: to the second, or to the
// millisecond under one.
func took(d time.Duration) string {
	if d < time.Second {
		return d.Round(time.Millisecond).String()
	}
	return d.Round(time.Second).String()
}
