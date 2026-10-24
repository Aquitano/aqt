package retrieve

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

type Result struct {
	Ref         string `json:"ref"`
	Blake3      string `json:"blake3"`
	Destination string `json:"destination"`
	EntryID     int64  `json:"entry_id"`
	VolumeID    string `json:"volume_id"`
	Source      string `json:"source"`
	Size        int64  `json:"size"`
}

func Get(ctx context.Context, content store.Retrieval, to string, known []store.Volume, mounted []disk.Volume, cfg config.Config) (result Result, err error) {
	if err := cfg.NormalizeTemp(); err != nil {
		return result, err
	}
	destination, err := destinationPath(to)
	if err != nil {
		return result, err
	}
	sel := selectCopies(content, known, mounted)
	for _, p := range sel.candidates {
		if err := scratch.CheckVolume(sel.mounts[p.VolumeID].Fingerprint, filepath.Dir(destination)); err != nil {
			return result, fmt.Errorf("destination must be off the source volume: %w", err)
		}
	}
	if len(sel.candidates) == 0 {
		return result, &UnavailableError{Volumes: sel.offline}
	}
	return copyCandidates(ctx, content, destination, sel.candidates, sel.offline, func(p store.Hit) (*os.File, error) {
		return openCopy(p, sel.mounts, known, cfg)
	})
}

// UnavailableError says no catalogued copy can be read on this machine: the
// disks that hold one are detached, or every attached copy is missing.
type UnavailableError struct {
	Volumes []OfflineVolume
}

// OfflineVolume is a detached disk that holds a copy.
type OfflineVolume struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

func (e *UnavailableError) Error() string {
	if len(e.Volumes) == 0 {
		return "no usable online copy; rescan a known volume to refresh missing or changed files"
	}
	names := make([]string, len(e.Volumes))
	for i, v := range e.Volumes {
		names[i] = fmt.Sprintf("%q (%s)", v.Label, v.ID)
	}
	return "no usable online copy; connect known volume(s): " + strings.Join(names, ", ")
}

// selection is where a content can be read on this machine now: present
// copies on attached disks, and the detached disks that hold the others.
type selection struct {
	mounts     map[string]disk.Volume
	candidates []store.Hit
	offline    []OfflineVolume
}

func selectCopies(content store.Retrieval, known []store.Volume, mounted []disk.Volume) selection {
	sel := selection{mounts: map[string]disk.Volume{}}
	for _, m := range mounted {
		if v := store.MatchMountedVolume(m.Fingerprint, known); v != nil {
			sel.mounts[v.ID] = m
		}
	}
	seenVolumes := map[string]bool{}
	for _, p := range content.Places {
		_, online := sel.mounts[p.VolumeID]
		if !online && !seenVolumes[p.VolumeID] {
			sel.offline = append(sel.offline, OfflineVolume{ID: p.VolumeID, Label: p.Volume})
			seenVolumes[p.VolumeID] = true
		}
		if online && !p.Missing {
			sel.candidates = append(sel.candidates, p)
		}
	}
	return sel
}

func openCopy(p store.Hit, mounts map[string]disk.Volume, known []store.Volume, cfg config.Config) (*os.File, error) {
	if cfg.Rules(p.VolumeID, mounts[p.VolumeID].Label).SkipContent(p.Path) {
		return nil, errors.New("excluded by current rules")
	}
	return openSource(p, mounts[p.VolumeID], known)
}

func copyCandidates(ctx context.Context, content store.Retrieval, destination string, candidates []store.Hit, offline []OfflineVolume, open func(store.Hit) (*os.File, error)) (result Result, err error) {
	if err := ctx.Err(); err != nil {
		return result, err
	}
	// Staging beside the destination keeps publication on one filesystem.
	// The configured scratch directory could require a second full-file copy.
	dir, err := os.MkdirTemp(filepath.Dir(destination), ".attic-get-*")
	if err != nil {
		return result, fmt.Errorf("destination: %w", err)
	}
	defer func() { err = errors.Join(err, os.RemoveAll(dir)) }()
	w := &scratch.Workspace{Path: dir}
	var failures []error
	for _, p := range candidates {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		f, copyErr := open(p)
		var copied string
		if copyErr == nil {
			copied, copyErr = w.CopyOpen(ctx, f, content.Digest, max(1, content.Size))
			copyErr = errors.Join(copyErr, f.Close())
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if copyErr != nil {
			if errors.As(copyErr, new(scratch.WriteError)) {
				return result, copyErr
			}
			failures = append(failures, fmt.Errorf("%s on %q: %w", p.Path, p.Volume, copyErr))
			continue
		}
		if err := publish(copied, destination); err != nil {
			return result, fmt.Errorf("destination: %w", err)
		}
		return Result{Ref: "attic:" + content.Ref, Blake3: hex.EncodeToString(content.Digest[:]), Destination: destination,
			EntryID: p.ID, VolumeID: p.VolumeID, Source: p.Path, Size: content.Size}, nil
	}
	return result, errors.Join(&UnavailableError{Volumes: offline}, errors.Join(failures...))
}

func destinationPath(to string) (string, error) {
	if to == "" {
		return "", errors.New("get needs --to <new-file>")
	}
	abs, err := filepath.Abs(to)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		return "", fmt.Errorf("destination directory: %w", err)
	}
	info, err := os.Stat(parent)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("destination parent is not a directory")
	}
	path := filepath.Join(parent, filepath.Base(abs))
	if _, err := os.Lstat(path); err == nil {
		return "", fmt.Errorf("destination exists: %w", os.ErrExist)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("destination: %w", err)
	}
	return path, nil
}

func openSource(p store.Hit, mount disk.Volume, known []store.Volume) (*os.File, error) {
	rel := filepath.FromSlash(strings.TrimPrefix(p.Path, "/"))
	if !filepath.IsLocal(rel) {
		return nil, fmt.Errorf("non-local catalogue path %q", p.Path)
	}
	f, err := disk.OpenOrdinary(mount.Root, rel)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "windows" {
		current, _, err := disk.Locate(filepath.Join(mount.Root, rel))
		if err != nil {
			f.Close()
			return nil, err
		}
		v := store.MatchMountedVolume(current.Fingerprint, known)
		if v == nil || v.ID != p.VolumeID {
			f.Close()
			return nil, errors.New("source volume identity changed")
		}
	}
	return f, nil
}
