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
	mounts := map[string]disk.Volume{}
	for _, m := range mounted {
		if v := store.MatchMountedVolume(m.Fingerprint, known); v != nil {
			mounts[v.ID] = m
		}
	}
	var candidates []store.Hit
	var unavailable []string
	seenVolumes := map[string]bool{}
	for _, p := range content.Places {
		m, online := mounts[p.VolumeID]
		if !online && !seenVolumes[p.VolumeID] {
			unavailable = append(unavailable, fmt.Sprintf("%q (%s)", p.Volume, p.VolumeID))
			seenVolumes[p.VolumeID] = true
		}
		if !online || p.Missing {
			continue
		}
		if err := scratch.CheckVolume(m.Fingerprint, filepath.Dir(destination)); err != nil {
			return result, fmt.Errorf("destination must be off the source volume: %w", err)
		}
		candidates = append(candidates, p)
	}
	if len(candidates) == 0 {
		return result, unavailableError(unavailable)
	}
	return copyCandidates(ctx, content, destination, candidates, unavailable, func(p store.Hit) (*os.File, error) {
		if cfg.Rules(p.VolumeID, p.Volume).SkipContent(p.Path) {
			return nil, errors.New("excluded by current rules")
		}
		return openSource(p, mounts[p.VolumeID], known)
	})
}

func copyCandidates(ctx context.Context, content store.Retrieval, destination string, candidates []store.Hit, unavailable []string, open func(store.Hit) (*os.File, error)) (result Result, err error) {
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
	return result, errors.Join(unavailableError(unavailable), errors.Join(failures...))
}

func unavailableError(volumes []string) error {
	if len(volumes) != 0 {
		return fmt.Errorf("no usable online copy; connect known volume(s): %s", strings.Join(volumes, ", "))
	}
	return errors.New("no usable online copy; rescan a known volume to refresh missing or changed files")
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
