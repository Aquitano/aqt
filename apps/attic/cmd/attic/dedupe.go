package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/dedupe"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/view"
)

type dedupeCmd struct {
	Plan  dedupePlanCmd  `cmd:"" help:"List the copies outside the kept folders that apply would set aside."`
	Apply dedupeApplyCmd `cmd:"" help:"Hash both copies again, then move each extra copy into its disk's .attic-quarantine folder."`
}

type dedupeFlags struct {
	Keep    []string `required:"" sep:"none" help:"Folder whose copies stay, such as E:\\Files; repeatable. A mounted folder, or volume-relative with --volume."`
	Volume  string   `help:"Volume label or ID for volume-relative --keep folders."`
	MinSize string   `default:"1M" help:"Ignore smaller contents, such as 10M."`
	Limit   int      `default:"100" help:"Maximum contents."`
	JSON    bool     `help:"Print JSON."`
}

// plan resolves the kept folders and returns the groups with the roots of
// the volumes attached now.
func (f *dedupeFlags) plan(ctx context.Context, st *store.Store) ([]store.DedupeGroup, map[string]string, error) {
	floor, err := parseSize(f.MinSize)
	if err != nil {
		return nil, nil, err
	}
	vols, err := st.KnownVolumes(ctx)
	if err != nil {
		return nil, nil, err
	}
	volumeID := ""
	if f.Volume != "" {
		v, err := st.FindVolume(ctx, f.Volume)
		if err != nil {
			return nil, nil, err
		}
		volumeID = v.ID
	}
	kept := make([]store.KeptFolder, len(f.Keep))
	for i, folder := range f.Keep {
		path, id, err := resolveUnder(folder, volumeID, vols)
		if err != nil {
			return nil, nil, err
		}
		kept[i] = store.KeptFolder{VolumeID: id, Path: path}
	}
	groups, err := st.DedupePlan(ctx, kept, floor, f.Limit)
	return groups, view.OnlineRoots(vols), err
}

type dedupePlanCmd struct {
	dedupeFlags `embed:""`
}

type planGroup struct {
	Ref   string       `json:"ref"`
	Size  int64        `json:"size"`
	Kept  []view.Place `json:"kept"`
	Extra []view.Place `json:"extra"`
}

func (cmd *dedupePlanCmd) Run(ctx context.Context) error {
	st, err := openReadOnlyStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	groups, roots, err := cmd.plan(ctx, st)
	if err != nil {
		return err
	}
	out := make([]planGroup, len(groups))
	var copies, bytes int64
	for i, g := range groups {
		out[i] = planGroup{Ref: g.Ref, Size: g.Size, Kept: view.Places(g.Kept, roots), Extra: view.Places(g.Extra, roots)}
		copies += int64(len(g.Extra))
		bytes += int64(len(g.Extra)) * g.Size
	}
	if cmd.JSON {
		return printJSON(out)
	}
	if len(out) == 0 {
		fmt.Println("no hashed content is stored both inside and outside the kept folders")
		return nil
	}
	for _, g := range out {
		fmt.Printf("attic:%s  %s\n", g.Ref, humanBytes(g.Size))
		for _, p := range g.Kept {
			fmt.Printf("  keep       %s%s\n", p.Display, offline(p))
		}
		for _, p := range g.Extra {
			fmt.Printf("  set aside  %s%s\n", p.Display, offline(p))
		}
	}
	fmt.Printf("\n%s extra copies of %s contents, %s. `attic dedupe apply` with the same flags moves the attached ones into each disk's %s folder.\n",
		count(copies), count(int64(len(out))), humanBytes(bytes), dedupe.Quarantine)
	return nil
}

func offline(p view.Place) string {
	if p.Online {
		return ""
	}
	return "  (offline)"
}

type dedupeApplyCmd struct {
	dedupeFlags `embed:""`
}

func (cmd *dedupeApplyCmd) Run(ctx context.Context) error {
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	groups, roots, err := cmd.plan(ctx, st)
	if err != nil {
		return err
	}
	res, err := dedupe.Apply(ctx, st, groups, roots, time.Now().Format("20060102-150405"))
	if cmd.JSON {
		return errors.Join(err, printJSON(res))
	}
	for _, m := range res.Moved {
		fmt.Printf("moved  %s\n    -> %s\n", m.From, m.To)
	}
	for _, s := range res.Skipped {
		fmt.Printf("kept   %s: %s\n", s.Path, s.Reason)
	}
	fmt.Printf("set aside %s copies, %s; %s left in place. The next scan of each folder marks the moved copies missing.\n",
		count(int64(len(res.Moved))), humanBytes(res.Bytes), count(int64(len(res.Skipped))))
	return err
}
