// Package scan walks one folder of one volume into the catalogue: it lists
// every folder, reconciles each listing with what the catalogue knew, then
// hashes the files whose content is still unknown.
package scan

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	gitconfig "github.com/go-git/go-git/v5/plumbing/format/config"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

type Options struct {
	// Path is the folder to scan, as the OS spells it.
	Path   string
	Config config.Config
	NoHash bool
	// VolumeID or NewVolume settle a fingerprint that resembles a known
	// volume without matching it (store.AmbiguousVolumeError).
	VolumeID  string
	NewVolume bool
	// Progress, when set, is called about twice a second.
	Progress func(Progress)

	locate func(string) (disk.Volume, []string, error)
}

type Progress struct {
	Phase string // walk | hash | archives
	store.ScanCounts
	Dirs int64
	// The hashing phase's totals, known when it starts.
	HashFiles int64
	HashBytes int64
	// The archives waiting to be listed when that phase starts, and the one
	// being read, volume-relative.
	ArchiveTotal int64
	Archive      string
}

type Result struct {
	ScanID  int64            `json:"scan_id"`
	Volume  store.Volume     `json:"volume"`
	Root    string           `json:"root"`
	Status  string           `json:"status"`
	Counts  store.ScanCounts `json:"counts"`
	Pending int64            `json:"pending"`
	Elapsed time.Duration    `json:"elapsed"`
}

const progressEvery = 500 * time.Millisecond

func Run(ctx context.Context, st *store.Store, o Options) (Result, error) {
	started := time.Now()
	locate := o.locate
	if locate == nil {
		locate = disk.Locate
	}
	mounted, rel, err := locate(o.Path)
	if err != nil {
		return Result{}, err
	}
	vol, err := st.ResolveVolume(ctx, mounted, o.VolumeID, o.NewVolume)
	if err != nil {
		return Result{}, err
	}
	root := ""
	for _, part := range rel {
		root += "/" + part
	}
	sc, err := st.StartScan(ctx, vol, root)
	if err != nil {
		return Result{}, err
	}
	a := o.Config.Archives
	r := &run{o: o, sc: sc, rules: o.Config.Rules(vol.ID, vol.Label), mountRoot: mounted.Root, lastProgress: time.Now(),
		archives: archive.Options{Depth: a.Depth, UnpackMaxBytes: a.UnpackMaxBytes, Temp: a.Temp}}
	status, runErr := r.phases(ctx, rel)
	if runErr != nil && ctx.Err() != nil {
		status, runErr = "interrupted", nil
	}
	finishErr := sc.Finish(ctx, status, runErr)
	res := Result{ScanID: sc.ID, Volume: vol, Root: root, Status: status, Counts: sc.Counts, Elapsed: time.Since(started)}
	if files, _, err := sc.PendingTotals(context.WithoutCancel(ctx)); err == nil {
		res.Pending = files
	}
	return res, errors.Join(runErr, finishErr)
}

type run struct {
	o            Options
	sc           *store.Scan
	rules        config.Rules
	mountRoot    string
	dirs         int64
	hashFiles    int64
	hashBytes    int64
	archives     archive.Options
	archiveTotal int64
	archive      string
	phase        string
	lastProgress time.Time
}

// osPath turns a volume-relative path back into one the OS opens.
func (r *run) osPath(p string) string {
	return filepath.Join(r.mountRoot, filepath.FromSlash(strings.TrimPrefix(p, "/")))
}

func (r *run) progress(force bool) {
	if r.o.Progress == nil || (!force && time.Since(r.lastProgress) < progressEvery) {
		return
	}
	r.lastProgress = time.Now()
	r.o.Progress(Progress{Phase: r.phase, ScanCounts: r.sc.Counts, Dirs: r.dirs, HashFiles: r.hashFiles, HashBytes: r.hashBytes,
		ArchiveTotal: r.archiveTotal, Archive: r.archive})
}

// phases walks, hashes and lists archives. Listings are keyed by content, so
// they wait for the hashes.
func (r *run) phases(ctx context.Context, rel []string) (string, error) {
	start, err := r.ancestors(ctx, rel)
	if err != nil {
		return "failed", err
	}
	r.phase = "walk"
	if err := r.walk(ctx, start); err != nil {
		return "failed", err
	}
	r.progress(true)
	if err := r.sc.Commit(ctx); err != nil {
		return "failed", err
	}
	if r.o.NoHash {
		return "complete", nil
	}
	if err := r.sc.SetStatus(ctx, "hashing"); err != nil {
		return "failed", err
	}
	r.phase = "hash"
	if err := r.hash(ctx); err != nil {
		return "failed", err
	}
	r.progress(true)
	if r.archives.Depth == 0 {
		return "complete", nil
	}
	if err := r.sc.Commit(ctx); err != nil {
		return "failed", err
	}
	if err := r.sc.SetStatus(ctx, "listing"); err != nil {
		return "failed", err
	}
	r.phase = "archives"
	if err := r.listArchives(ctx); err != nil {
		return "failed", err
	}
	r.progress(true)
	return "complete", nil
}

// folderJob is a folder waiting to be listed. os is its path as the file
// system spells it: a name that is not valid Unicode is stored cleaned, and a
// path rebuilt from the catalogue would not reopen it. lossy marks such a path,
// whose files the hashing phase could not open either.
type folderJob struct {
	dir   store.Dir
	os    string
	lossy bool
}

// ancestors records the volume root and every folder down to the scan root,
// without listing them: a scan of E:\Files\Archive must not mark the rest of
// E:\Files missing.
func (r *run) ancestors(ctx context.Context, rel []string) (folderJob, error) {
	var parent *store.Dir
	p := r.mountRoot
	lossy := false
	for i := 0; i <= len(rel); i++ {
		name := ""
		if i > 0 {
			name = rel[i-1]
			p = filepath.Join(p, name)
			lossy = lossy || !utf8.ValidString(name)
		}
		e, err := disk.Stat(p)
		if err != nil {
			return folderJob{}, err
		}
		if !e.Dir || e.Link {
			return folderJob{}, fmt.Errorf("%s is not a folder", p)
		}
		e.Name = name
		dirs, err := r.sc.ApplyListing(ctx, parent, []store.Listed{listed(e)}, nil, false)
		if err != nil {
			return folderJob{}, err
		}
		parent = &dirs[0]
	}
	return folderJob{dir: *parent, os: p, lossy: lossy}, nil
}

// volumeGone tells a disk unplugged mid-scan from a folder or file that cannot
// be read: the first ends the scan, the second is one skip.
func (r *run) volumeGone() error {
	if _, err := os.Stat(r.mountRoot); err != nil {
		return fmt.Errorf("%s disappeared during the scan; run it again once it is back: %w", r.mountRoot, err)
	}
	return nil
}

func listed(e disk.Entry) store.Listed {
	l := store.Listed{
		Name:       e.Name,
		Kind:       "file",
		FileID:     int64(e.FileID),
		Size:       e.Size,
		Created:    e.Created,
		Modified:   e.Modified,
		Accessed:   e.Accessed,
		Changed:    e.Changed,
		Attributes: int32(e.Attributes),
		HashState:  "pending",
	}
	switch {
	case e.Link:
		l.Kind = "link"
	case e.Dir:
		l.Kind = "dir"
	}
	return l
}

// walk lists folders depth-first with an explicit stack: backup trees nest
// deep enough that recursion depth is not worth thinking about.
func (r *run) walk(ctx context.Context, start folderJob) error {
	stack := []folderJob{start}
	for len(stack) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		job := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		children, err := r.folder(ctx, job)
		if err != nil {
			return err
		}
		for i := len(children) - 1; i >= 0; i-- {
			stack = append(stack, children[i])
		}
		r.dirs++
		if err := r.sc.MaybeCommit(ctx); err != nil {
			return err
		}
		r.progress(false)
	}
	return nil
}

// folder lists one folder, applies the rules to each entry and hands the
// result to the catalogue. A folder that cannot be read is skipped with its
// reason and leaves its catalogued children untouched.
func (r *run) folder(ctx context.Context, job folderJob) ([]folderJob, error) {
	dir := job.dir
	entries, err := disk.List(job.os)
	if err != nil {
		if gone := r.volumeGone(); gone != nil {
			return nil, gone
		}
		r.sc.Skip(dir.Path, "unreadable", "", err.Error())
		return nil, nil
	}
	lowerDir := lowerComponents(dir.Path)
	keep := map[string]bool{}
	items := make([]store.Listed, 0, len(entries))
	var dirNames []string
	repo := false
	for _, e := range entries {
		childPath := dir.Path + "/" + e.Name
		if e.Name == ".git" {
			repo = true
		}
		lower := slices.Concat(lowerDir, []string{strings.ToLower(e.Name)})
		if excluded, rule := r.rules.Excluded(lower, e.Dir && !e.Link); excluded {
			r.sc.Skip(childPath, "excluded", rule, "")
			keep[e.Name] = true
			continue
		}
		l := listed(e)
		switch {
		case l.Kind == "link":
			r.sc.Skip(childPath, "link", "", "a junction, symlink or placeholder; not followed")
		case l.Kind != "file":
			dirNames = append(dirNames, e.Name)
		case job.lossy || !utf8.ValidString(e.Name):
			l.HashState = "skipped"
			r.sc.Skip(childPath, "bad_name", "", "the path is not valid Unicode, so the file cannot be reopened to hash it")
		case e.Remote:
			l.HashState = "skipped"
			r.sc.Skip(childPath, "remote", "", "bytes live elsewhere; reading would download them")
		case r.rules.NameOnly(lower):
			l.HashState = "skipped"
			r.sc.Skip(childPath, "name_only", "", "")
		case r.rules.HashMaxBytes > 0 && e.Size > r.rules.HashMaxBytes:
			l.HashState = "skipped"
			r.sc.Skip(childPath, "too_big", "", fmt.Sprintf("%d bytes", e.Size))
		}
		items = append(items, l)
	}
	children, err := r.sc.ApplyListing(ctx, &dir, items, keep, true)
	if err != nil {
		return nil, err
	}
	if len(children) != len(dirNames) {
		return nil, fmt.Errorf("%s: %d subfolders listed, %d recorded", dir.Path, len(dirNames), len(children))
	}
	if repo {
		if err := r.sc.SetGitRemote(ctx, dir, origin(job.os)); err != nil {
			return nil, err
		}
	}
	jobs := make([]folderJob, len(children))
	for i, child := range children {
		jobs[i] = folderJob{dir: child, os: filepath.Join(job.os, dirNames[i]), lossy: job.lossy || !utf8.ValidString(dirNames[i])}
	}
	return jobs, nil
}

func lowerComponents(p string) []string {
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return nil
	}
	return strings.Split(strings.ToLower(p), "/")
}

// origin reads a repository's origin URL. A worktree or submodule keeps a
// .git file instead of a folder, and an unreadable config is simply a
// repository without a known remote.
func origin(dir string) string {
	data, err := disk.ReadSmall(filepath.Join(dir, ".git", "config"), 1<<20)
	if err != nil {
		return ""
	}
	cfg := gitconfig.New()
	if err := gitconfig.NewDecoder(bytes.NewReader(data)).Decode(cfg); err != nil {
		return ""
	}
	return cfg.Section("remote").Subsection("origin").Option("url")
}

// hash works through the files below the scan root whose content is unknown,
// in path order so a hard disk reads roughly sequentially.
func (r *run) hash(ctx context.Context) error {
	var err error
	if r.hashFiles, r.hashBytes, err = r.sc.PendingTotals(ctx); err != nil {
		return err
	}
	r.progress(true)
	var after store.Pending
	for {
		batch, err := r.sc.NextPending(ctx, after, 256)
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			return nil
		}
		for _, p := range batch {
			after = p
			if err := r.hashOne(ctx, p); err != nil {
				return err
			}
			if err := r.sc.MaybeCommit(ctx); err != nil {
				return err
			}
			r.progress(false)
		}
	}
}

func (r *run) hashOne(ctx context.Context, p store.Pending) error {
	// A file listed by an earlier scan was queued under the rules of that day.
	// Exclusions and caps added since must still keep its bytes unread.
	path := lowerComponents(p.Path)
	if excluded, rule := r.rules.Excluded(path, false); excluded {
		return r.sc.SkipHash(ctx, p, "excluded", rule, "")
	}
	if r.rules.NameOnly(path) {
		return r.sc.SkipHash(ctx, p, "name_only", "", "")
	}
	if r.rules.HashMaxBytes > 0 && p.Size > r.rules.HashMaxBytes {
		return r.sc.SkipHash(ctx, p, "too_big", "", fmt.Sprintf("%d bytes", p.Size))
	}
	digest, n, err := disk.Hash(ctx, r.osPath(p.Path))
	switch {
	case ctx.Err() != nil:
		return ctx.Err()
	case err != nil:
		if gone := r.volumeGone(); gone != nil {
			return gone
		}
		return r.sc.HashFailed(ctx, p, err)
	case n != p.Size:
		r.sc.Skip(p.Path, "changed", "", fmt.Sprintf("listed %d bytes, read %d; hashed on the next scan", p.Size, n))
		return nil
	}
	return r.sc.SetContent(ctx, p, digest)
}

// listArchives reads the archives below the scan root whose content has no
// listing yet, in path order like hashing.
func (r *run) listArchives(ctx context.Context) error {
	var err error
	if r.archiveTotal, err = r.sc.ArchiveTotals(ctx); err != nil {
		return err
	}
	r.progress(true)
	var after store.PendingArchive
	for {
		batch, err := r.sc.NextArchives(ctx, after, 64)
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			return nil
		}
		for _, a := range batch {
			after = a
			if err := r.listArchive(ctx, a); err != nil {
				return err
			}
			if err := r.sc.MaybeCommit(ctx); err != nil {
				return err
			}
			r.progress(false)
		}
	}
}

func (r *run) listArchive(ctx context.Context, a store.PendingArchive) error {
	// Hashed under older rules; the ones in force now may forbid reading it.
	path := lowerComponents(a.Path)
	if excluded, _ := r.rules.Excluded(path, false); excluded || r.rules.NameOnly(path) {
		return nil
	}
	l, err := r.sc.StartListing(ctx, a.ContentID)
	if err != nil || l == nil {
		return err
	}
	r.archive = a.Path
	r.progress(false)
	var skips []archive.Skip
	res, err := archive.List(ctx, r.osPath(a.Path), disk.Open, r.archives,
		func(m archive.Member) error {
			r.progress(false)
			return l.Add(ctx, m)
		},
		func(s archive.Skip) { skips = append(skips, s) })
	if err == nil && res.Status != archive.Listed {
		// A disk unplugged mid-read looks like a damaged archive.
		err = r.volumeGone()
	}
	if err != nil {
		l.Abort(ctx)
		var unreadable archive.UnreadableError
		if !errors.As(err, &unreadable) || ctx.Err() != nil {
			return err
		}
		if gone := r.volumeGone(); gone != nil {
			return gone
		}
		r.sc.Skip(a.Path, "unreadable", "", err.Error())
		return nil
	}
	if err := l.Finish(ctx, res); err != nil {
		return err
	}
	if res.Status != archive.Listed {
		r.sc.Skip(a.Path, res.Status, "", res.Detail)
	}
	for _, s := range skips {
		r.sc.Skip(a.Path+archive.Separator+s.Path, s.Reason, "", s.Detail)
	}
	return nil
}
