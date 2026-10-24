package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

type coverageCmd struct {
	Volume string `help:"Volume label or ID."`
	Under  string `help:"Mounted path, or volume-relative path with --volume."`
	Limit  int    `default:"20" help:"Maximum contents and unknown files per page (1 to 1000)."`
	Offset int    `help:"Skip this many contents and unknown files."`
	JSON   bool   `help:"Print JSON."`
}

func (cmd *coverageCmd) Run(ctx context.Context) error {
	if cmd.Limit < 1 || cmd.Limit > 1000 || cmd.Offset < 0 {
		return errors.New("coverage needs a limit from 1 to 1000 and a non-negative offset")
	}
	st, err := openReadOnlyStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	o := store.CoverageOptions{Limit: cmd.Limit, Offset: cmd.Offset}
	if cmd.Volume != "" {
		v, err := st.FindVolume(ctx, cmd.Volume)
		if err != nil {
			return err
		}
		o.VolumeID = v.ID
	}
	if cmd.Under != "" {
		vols, err := st.KnownVolumes(ctx)
		if err != nil {
			return err
		}
		if o.Under, o.VolumeID, err = resolveUnder(cmd.Under, o.VolumeID, vols); err != nil {
			return err
		}
	}
	r, err := st.Coverage(ctx, o)
	if err != nil {
		return err
	}
	return printCoverage(os.Stdout, r, cmd.JSON)
}

func printCoverage(w io.Writer, r store.CoverageReport, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(r)
	}
	out := bufio.NewWriter(w)
	fmt.Fprintf(out, "%s unique contents, %s; %s on fewer than two recorded volumes, %s\n",
		count(r.Contents), humanBytes(r.Bytes), count(r.Undercovered), humanBytes(r.UndercoveredBytes))
	fmt.Fprintf(out, "%s unknown files, %s of path sizes (not deduplicated)\n", count(r.UnknownFiles), humanBytes(r.UnknownBytes))
	fmt.Fprintln(out, "Recorded copies include offline volumes and exclude missing entries. This does not verify backup health or physical disk independence.")
	fmt.Fprintf(out, "Page offset %d, limit %d for each list; up to %d locations per content. Dates are recorded update scan starts.\n", r.Offset, r.Limit, r.LocationLimit)
	for _, c := range r.Content {
		fmt.Fprintf(out, "\n%s, %d recorded volumes, %d paths, BLAKE3 %s\n", humanBytes(c.Size), c.Volumes, c.Copies, c.BLAKE3)
		for _, l := range c.Locations {
			printCoverageLocation(out, l)
		}
	}
	if len(r.Unknown) > 0 {
		fmt.Fprintln(out, "\nUnknown content hashes:")
		for _, l := range r.Unknown {
			printCoverageLocation(out, l)
		}
	}
	return out.Flush()
}

func printCoverageLocation(w io.Writer, l store.CoverageLocation) {
	fmt.Fprintf(w, "  %d  %s [%s]:%s  %s  scan %d at %s\n", l.ID, l.Volume, l.VolumeID,
		l.Path, humanBytes(l.Size), l.UpdatedScan, l.Updated.Format(time.RFC3339))
}
