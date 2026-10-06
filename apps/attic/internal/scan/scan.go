// Package scan walks one folder of one volume into the catalogue: it lists
// every folder, reconciles each listing with what the catalogue knew, then
// hashes the files whose content is still unknown.
package scan

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	gitconfig "github.com/go-git/go-git/v5/plumbing/format/config"

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
	Phase string // walk | hash
	store.ScanCounts
	Dirs int64
	// The hashing phase's totals, known when it starts.
	HashFiles int64
	HashBytes int64
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
	r := &run{o: o, sc: sc, rules: o.Config.Rules(vol.ID, vol.Label), mountRoot: mounted.Root, lastProgress: time.Now()}
	status, runErr := r.walkAndHash(ctx, rel)
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
	r.o.Progress(Progress{Phase: r.phase, ScanCounts: r.sc.Counts, Dirs: r.dirs, HashFiles: r.hashFiles, HashBytes: r.hashBytes})
}

func (r *run) walkAndHash(ctx context.Context, rel []string) (string, error) {
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
	return "complete", nil
}

// ancestors records the volume root and every folder down to the scan root,
// without listing them: a scan of E:\Files\Archive must not mark the rest of
// E:\Files missing.
func (r *run) ancestors(ctx context.Context, rel []string) (store.Dir, error) {
	var parent *store.Dir
	p := r.mountRoot
	for i := 0; i <= len(rel); i++ {
		name := ""
		if i > 0 {
			name = rel[i-1]
			p = filepath.Join(p, name)
		}
		e, err := disk.Stat(p)
		if err != nil {
			return store.Dir{}, err
		}
		if !e.Dir || e.Link {
			return store.Dir{}, fmt.Errorf("%s is not a folder", p)
		}
		e.Name = name
		dirs, err := r.sc.ApplyListing(ctx, parent, []store.Listed{listed(e)}, nil, false)
		if err != nil {
			return store.Dir{}, err
		}
		parent = &dirs[0]
	}
	return *parent, nil
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
func (r *run) walk(ctx context.Context, start store.Dir) error {
	stack := []store.Dir{start}
	for len(stack) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		children, err := r.folder(ctx, dir)
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
func (r *run) folder(ctx context.Context, dir store.Dir) ([]store.Dir, error) {
	entries, err := disk.List(r.osPath(dir.Path))
	if err != nil {
		r.sc.Skip(dir.Path, "unreadable", "", err.Error())
		return nil, nil
	}
	lowerDir := lowerComponents(dir.Path)
	keep := map[string]bool{}
	items := make([]store.Listed, 0, len(entries))
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
	if repo {
		if err := r.sc.SetGitRemote(ctx, dir, r.origin(dir)); err != nil {
			return nil, err
		}
	}
	return children, nil
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
func (r *run) origin(dir store.Dir) string {
	data, err := disk.ReadSmall(filepath.Join(r.osPath(dir.Path), ".git", "config"), 1<<20)
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
	after := ""
	for {
		batch, err := r.sc.NextPending(ctx, after, 256)
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			return nil
		}
		for _, p := range batch {
			digest, n, err := disk.Hash(ctx, r.osPath(p.Path))
			switch {
			case ctx.Err() != nil:
				return ctx.Err()
			case err != nil:
				err = r.sc.HashFailed(ctx, p, err)
			case n != p.Size:
				r.sc.Skip(p.Path, "changed", "", fmt.Sprintf("listed %d bytes, read %d; hashed on the next scan", p.Size, n))
			default:
				err = r.sc.SetContent(ctx, p, digest)
			}
			if err != nil {
				return err
			}
			after = p.Path
			if err := r.sc.MaybeCommit(ctx); err != nil {
				return err
			}
			r.progress(false)
		}
	}
}
