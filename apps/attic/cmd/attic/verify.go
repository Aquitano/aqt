package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/verify"
)

type verifyCmd struct {
	Under  string `help:"Required mounted folder, or volume-relative path with --volume."`
	Volume string `help:"Volume label or ID; confirms ambiguous mounted identity."`
	JSON   bool   `help:"Stream newline-delimited JSON entries followed by a summary."`
}

func (cmd *verifyCmd) Run(ctx context.Context) error {
	if strings.TrimSpace(cmd.Under) == "" {
		return errors.New("verify requires --under; select the folder to reread explicitly")
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	volumes, err := st.KnownVolumes(ctx)
	if err != nil {
		return err
	}
	volumeID := ""
	if cmd.Volume != "" {
		v, err := st.FindVolume(ctx, cmd.Volume)
		if err != nil {
			return err
		}
		volumeID = v.ID
	}
	under, volumeID, mount, err := verificationScope(cmd.Under, volumeID, volumes)
	if err != nil {
		return err
	}
	return writeVerification(ctx, st, volumeID, under, mount, cmd.JSON, os.Stdout)
}

func verificationScope(under, volumeID string, volumes []store.Volume) (string, string, disk.Volume, error) {
	if strings.HasPrefix(under, "/") {
		if volumeID == "" {
			return "", "", disk.Volume{}, errors.New("--under /path needs --volume; or give a mounted folder such as E:\\Files")
		}
		if strings.Contains(under, "\\") || path.Clean(under) != strings.TrimSuffix(under, "/") && under != "/" {
			return "", "", disk.Volume{}, errors.New("use a normalized volume-relative path without dot components")
		}
		var mount disk.Volume
		for _, m := range disk.Mounted() {
			if _, err := verify.MatchVolume(m, volumes, volumeID); err == nil {
				if mount.Root != "" {
					return "", "", disk.Volume{}, errors.New("multiple mounted disks match --volume; use a mounted --under path")
				}
				mount = m
			}
		}
		return strings.TrimSuffix(under, "/"), volumeID, mount, nil
	}
	mount, parts, err := locateVerificationScope(under)
	if err != nil {
		return "", "", disk.Volume{}, fmt.Errorf("locate scope: %w", err)
	}
	abs, err := filepath.Abs(under)
	if err != nil {
		return "", "", disk.Volume{}, err
	}
	resolved := filepath.Join(append([]string{mount.Root}, parts...)...)
	if !strings.EqualFold(filepath.Clean(abs), filepath.Clean(resolved)) {
		return "", "", disk.Volume{}, errors.New("--under resolves through a link or alias; select the ordinary mounted path explicitly")
	}
	volumeID, err = verify.MatchVolume(mount, volumes, volumeID)
	if err != nil {
		return "", "", disk.Volume{}, err
	}
	return strings.TrimSuffix("/"+strings.Join(parts, "/"), "/"), volumeID, mount, nil
}

func locateVerificationScope(under string) (disk.Volume, []string, error) {
	abs, err := filepath.Abs(under)
	if err != nil {
		return disk.Volume{}, nil, err
	}
	var missing []string
	for {
		mount, parts, err := disk.Locate(abs)
		if err == nil {
			return mount, append(parts, missing...), nil
		}
		parent := filepath.Dir(abs)
		if !errors.Is(err, os.ErrNotExist) || parent == abs {
			return disk.Volume{}, nil, err
		}
		missing = append([]string{filepath.Base(abs)}, missing...)
		abs = parent
	}
}

func writeVerification(ctx context.Context, st *store.Store, volumeID, under string, mount disk.Volume, jsonOutput bool, out io.Writer) error {
	enc := json.NewEncoder(out)
	summary, runErr := verify.Run(ctx, st, volumeID, under, mount, func(r verify.Result) error {
		if jsonOutput {
			return enc.Encode(r)
		}
		_, err := fmt.Fprintf(out, "%s\t%s\t%s\n", r.Status, r.Path, r.Detail)
		return err
	})
	var err error
	if jsonOutput {
		err = enc.Encode(summary)
	} else {
		_, err = fmt.Fprintf(out, "%d matched, %d mismatched, %d unreadable, %d missing, %d unavailable, %d unknown, %d interrupted; complete: %t\n",
			summary.Matched, summary.Mismatched, summary.Unreadable, summary.Missing, summary.Unavailable, summary.Unknown, summary.Interrupted, summary.Complete)
	}
	return errors.Join(runErr, err)
}
