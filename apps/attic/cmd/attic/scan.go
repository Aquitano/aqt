package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/scan"
)

func cmdScan(ctx context.Context, args []string) error {
	flagArgs, pos := interspersed(args, map[string]bool{"no-hash": true, "new-volume": true, "json": true})
	fs := flag.NewFlagSet("scan", flag.ExitOnError)
	configPath := fs.String("config", "", "")
	noHash := fs.Bool("no-hash", false, "")
	volume := fs.String("volume", "", "")
	newVolume := fs.Bool("new-volume", false, "")
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(flagArgs)
	if len(pos) != 1 {
		return fmt.Errorf("scan needs one folder: %w", errUsage)
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

	p := &progressLine{tty: stderrIsTerminal(), started: time.Now()}
	res, err := scan.Run(ctx, st, scan.Options{
		Path: pos[0], Config: cfg, NoHash: *noHash, VolumeID: *volume, NewVolume: *newVolume, Progress: p.update,
	})
	p.clear()
	if res.ScanID == 0 {
		return err
	}
	if *asJSON {
		if jerr := printJSON(res); jerr != nil {
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
	if res.Status == "interrupted" {
		fmt.Println("  run the same command again to continue; finished work is kept")
	}
	return err
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
