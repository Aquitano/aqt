// Package verify compares selected catalogue copies with their stored digests.
package verify

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

type Result struct {
	Type     string `json:"type"`
	ID       int64  `json:"id,omitempty"`
	Path     string `json:"path"`
	Status   string `json:"status"`
	Expected string `json:"expected,omitempty"`
	Actual   string `json:"actual,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Bytes    int64  `json:"bytes"`
}

type Summary struct {
	Type        string `json:"type"`
	VolumeID    string `json:"volume_id"`
	Under       string `json:"under"`
	Matched     int64  `json:"matched"`
	Mismatched  int64  `json:"mismatched"`
	Unreadable  int64  `json:"unreadable"`
	Missing     int64  `json:"missing"`
	Unavailable int64  `json:"unavailable"`
	Unknown     int64  `json:"unknown"`
	Interrupted int64  `json:"interrupted"`
	Complete    bool   `json:"complete"`
}

func Run(ctx context.Context, st *store.Store, volumeID, under string, mount disk.Volume, report func(Result) error) (Summary, error) {
	summary := Summary{Type: "summary", VolumeID: volumeID, Under: under}
	var selected int64
	err := st.WalkVerification(ctx, volumeID, under, func(f store.VerifyFile) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		selected++
		r := readOne(ctx, mount, f)
		switch r.Status {
		case "matched":
			summary.Matched++
		case "mismatched":
			summary.Mismatched++
		case "unreadable":
			summary.Unreadable++
		case "missing":
			summary.Missing++
		case "unavailable":
			summary.Unavailable++
		case "unknown":
			summary.Unknown++
		case "interrupted":
			summary.Interrupted++
		}
		return errors.Join(report(r), ctx.Err())
	})
	if err != nil {
		return summary, err
	}
	if selected == 0 {
		summary.Unknown++
		if err := report(Result{Type: "entry", Path: under, Status: "unknown", Detail: "no catalogue files in this scope"}); err != nil {
			return summary, err
		}
	}
	if err := ctx.Err(); err != nil {
		return summary, err
	}
	summary.Complete = true
	if summary.Mismatched+summary.Unreadable+summary.Missing+summary.Unavailable+summary.Unknown > 0 {
		return summary, errors.New("verification did not match every selected file; see the report")
	}
	return summary, nil
}

func readOne(ctx context.Context, mount disk.Volume, f store.VerifyFile) Result {
	r := Result{Type: "entry", ID: f.ID, Path: f.Path, Expected: hex.EncodeToString(f.Digest)}
	switch {
	case f.Kind != "file":
		r.Status, r.Detail = "unavailable", "catalogue entry is not an ordinary file"
	case f.HashState != "done" || len(f.Digest) != len(disk.Digest{}):
		r.Status, r.Detail = "unknown", "no full stored digest; hash state: "+f.HashState
	case mount.Root == "":
		r.Status, r.Detail = "unavailable", "selected volume is offline"
	default:
		if runtime.GOOS == "windows" {
			current, _, err := disk.Locate(mount.Root)
			if err != nil || current.Fingerprint != mount.Fingerprint {
				r.Status, r.Detail = "unavailable", "source volume is unavailable or its identity changed"
				return r
			}
		}
		rel := filepath.FromSlash(strings.TrimPrefix(f.Path, "/"))
		digest, n, err := disk.HashOrdinary(ctx, mount.Root, rel)
		r.Bytes = n
		switch {
		case ctx.Err() != nil:
			r.Status, r.Detail = "interrupted", ctx.Err().Error()
		case errors.Is(err, os.ErrNotExist):
			r.Status, r.Detail = "missing", err.Error()
		case errors.Is(err, disk.ErrNotOrdinary):
			r.Status, r.Detail = "unavailable", err.Error()
		case err != nil:
			r.Status, r.Detail = "unreadable", err.Error()
		default:
			r.Actual = hex.EncodeToString(digest[:])
			if r.Actual == r.Expected {
				r.Status = "matched"
			} else {
				r.Status = "mismatched"
			}
			if f.Missing {
				r.Detail = "catalogue marks this copy missing; checked the selected path without changing that record"
			}
		}
	}
	return r
}

// MatchVolume applies scan identity rules without touching the volume record.
func MatchVolume(m disk.Volume, volumes []store.Volume, selected string) (string, error) {
	var matches []string
	for _, v := range volumes {
		if selected != "" {
			if v.ID == selected && v.FS == m.FS && v.Serial == m.Serial {
				return v.ID, nil
			}
		} else if v.Holds(m.Fingerprint) && m.DeviceSerial != "" && v.DeviceSerial == m.DeviceSerial {
			matches = append(matches, v.ID)
		}
	}
	if selected == "" && len(matches) == 1 {
		return matches[0], nil
	}
	return "", errors.New("mounted volume cannot be identified uniquely; select its catalogue ID with --volume (filesystem and serial must match)")
}
