package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type redundancyCmd struct {
	Volume string `help:"Volume label or ID."`
	Under  string `help:"Mounted path, or volume-relative path with --volume."`
	Limit  int    `default:"${limit}" help:"Maximum contents and unknown files per page, 1-${max_limit}."`
	Offset int    `help:"Skip this many contents and unknown files, at most ${max_offset}."`
	JSON   bool   `help:"Print JSON."`
}

func (cmd *redundancyCmd) Run(ctx context.Context, connect connector) error {
	if err := page.Check(cmd.Limit, cmd.Offset); err != nil {
		return err
	}
	bank, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	in := server.RedundancyInput{Volume: cmd.Volume, Page: httpapi.Page{PageSize: httpapi.PageSize{Limit: cmd.Limit}, Offset: cmd.Offset}}
	if cmd.Under != "" && !strings.HasPrefix(cmd.Under, "/") {
		vols, err := knownVolumes(ctx, bank)
		if err != nil {
			return err
		}
		if in.Volume, err = volumeID(vols, cmd.Volume); err != nil {
			return err
		}
		if in.Under, in.Volume, err = resolveUnder(cmd.Under, in.Volume, vols); err != nil {
			return err
		}
	} else {
		in.Under = cmd.Under
	}
	r, err := client.Call(ctx, bank, server.GetDiskRedundancy, in)
	if err != nil {
		return err
	}
	return printRedundancy(os.Stdout, r, cmd.JSON)
}

func printRedundancy(w io.Writer, r store.RedundancyReport, asJSON bool) error {
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(r)
	}
	out := bufio.NewWriter(w)
	fmt.Fprintf(out, "%s unique contents, %s; %s on fewer than two recorded volumes, %s\n",
		count(r.Contents), humanSize(r.Bytes), count(r.SingleVolume), humanSize(r.SingleVolumeBytes))
	fmt.Fprintf(out, "%s unknown files, %s of path sizes (not deduplicated)\n", count(r.UnknownFiles), humanSize(r.UnknownBytes))
	fmt.Fprintln(out, "Recorded copies include offline volumes and exclude missing entries. This does not verify backup health or physical disk independence.")
	fmt.Fprintf(out, "Page offset %d, limit %d for each list; up to %d locations per content. Dates are recorded update scan starts.\n", r.Offset, r.Limit, r.LocationLimit)
	for _, c := range r.Content {
		fmt.Fprintf(out, "\n%s, %d recorded volumes, %d paths, BLAKE3 %s\n", humanSize(c.Size), c.Volumes, c.Copies, c.BLAKE3)
		for _, l := range c.Locations {
			printRedundancyLocation(out, l)
		}
	}
	if len(r.Unknown) > 0 {
		fmt.Fprintln(out, "\nUnknown content hashes:")
		for _, l := range r.Unknown {
			printRedundancyLocation(out, l)
		}
	}
	return out.Flush()
}

func printRedundancyLocation(w io.Writer, l store.RedundancyLocation) {
	fmt.Fprintf(w, "  %d  %s [%s]:%s  %s  scan %d at %s\n", l.ID, l.Volume, l.VolumeID,
		l.Path, humanSize(l.Size), l.UpdatedScan, l.Updated.Format(time.RFC3339))
}
