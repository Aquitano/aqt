package main

import (
	"cmp"
	"context"
	"errors"
	"flag"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

// hitOut is a hit as printed, with the path spelled for opening.
type hitOut struct {
	store.Hit
	Display string `json:"display"`
	Online  bool   `json:"online"`
}

func outHits(hits []store.Hit, roots map[string]string) []hitOut {
	out := make([]hitOut, len(hits))
	for i, h := range hits {
		_, online := roots[h.VolumeID]
		out[i] = hitOut{Hit: h, Display: displayPath(h.VolumeID, h.Volume, h.Path, roots), Online: online}
	}
	return out
}

func printHits(hits []hitOut) error {
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', tabwriter.AlignRight)
	for _, h := range hits {
		size := humanBytes(h.Size)
		if h.Kind != "file" {
			size = h.Kind
		}
		var notes []string
		if !h.Online {
			notes = append(notes, "offline")
		}
		if h.Missing {
			notes = append(notes, "missing")
		}
		note := ""
		if len(notes) > 0 {
			note = "  (" + strings.Join(notes, ", ") + ")"
		}
		// Text after the last tab is not a column, so the path stays left-aligned.
		fmt.Fprintf(tw, "%d\t%s\t%s\t  %s%s\n", h.ID, size, shortDate(h.Modified), h.Display, note)
	}
	return tw.Flush()
}

func cmdSearch(ctx context.Context, args []string) error {
	flagArgs, words := interspersed(args, map[string]bool{"any": true, "json": true})
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	anyWord := fs.Bool("any", false, "")
	volume := fs.String("volume", "", "")
	ext := fs.String("ext", "", "")
	kind := fs.String("kind", "", "")
	under := fs.String("under", "", "")
	limit := fs.Int("limit", 20, "")
	offset := fs.Int("offset", 0, "")
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(flagArgs)

	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	vols, err := st.KnownVolumes(ctx)
	if err != nil {
		return err
	}
	o := store.SearchOptions{Query: strings.Join(words, " "), Any: *anyWord, Ext: *ext, Kind: *kind, Limit: *limit, Offset: *offset}
	if *volume != "" {
		v, err := st.FindVolume(ctx, *volume)
		if err != nil {
			return err
		}
		o.VolumeID = v.ID
	}
	if *under != "" {
		if o.Under, o.VolumeID, err = resolveUnder(*under, o.VolumeID, vols); err != nil {
			return err
		}
	}
	hits, err := st.Search(ctx, o)
	if err != nil {
		return err
	}
	members, err := st.SearchMembers(ctx, o)
	if err != nil {
		return err
	}
	texts, err := st.SearchTexts(ctx, o)
	if err != nil {
		return err
	}
	meta, err := st.SearchMetadata(ctx, o)
	if err != nil {
		return err
	}
	analyses, err := st.SearchAI(ctx, o)
	if err != nil {
		return err
	}
	roots := onlineRoots(vols)
	out, inside, docs := outHits(hits, roots), outMembers(members, roots), outTexts(texts, roots)
	if *asJSON {
		return printJSON(struct {
			Entries  []hitOut      `json:"entries"`
			Members  []memberOut   `json:"members"`
			Texts    []textOut     `json:"texts"`
			Metadata []textOut     `json:"metadata"`
			Analyses []analysisOut `json:"analyses"`
		}{out, inside, docs, outTexts(meta, roots), outAnalyses(analyses, roots)})
	}
	if err := printHits(out); err != nil {
		return err
	}
	// Each BM25 index scores on its own scale, so archive members and document
	// text get their own ranking instead of being merged into the files'.
	if len(inside) > 0 {
		fmt.Println("\ninside archives:")
		if err := printMembers(inside); err != nil {
			return err
		}
	}
	if len(docs) > 0 {
		fmt.Println("\nin documents:")
		printTexts(docs)
	}
	if len(meta) > 0 {
		fmt.Println("\nin metadata:")
		printTexts(outTexts(meta, roots))
	}
	if len(analyses) > 0 {
		fmt.Println("\nin OCR and descriptions:")
		for _, a := range outAnalyses(analyses, roots) {
			fmt.Printf("  %s / %s / %s\n", a.Task, a.Provider, a.Model)
			printTexts([]textOut{a.textOut})
		}
	}
	return nil
}

// bestCopy is the copy to show: one that can be opened now, or the first
// present one, as occurrences sorts them.
func bestCopy(copies []hitOut) hitOut {
	if len(copies) == 0 {
		return hitOut{}
	}
	return copies[max(slices.IndexFunc(copies, func(h hitOut) bool { return h.Online && !h.Missing }), 0)]
}

// textOut is a document hit as printed, at its best copy.
type textOut struct {
	store.TextHit
	Display string   `json:"display"`
	Online  bool     `json:"online"`
	Places  []hitOut `json:"places"`
	shown   hitOut
}

func outTexts(texts []store.TextHit, roots map[string]string) []textOut {
	out := make([]textOut, len(texts))
	for i, t := range texts {
		places := outHits(t.Places, roots)
		shown := bestCopy(places)
		out[i] = textOut{TextHit: t, Display: shown.Display, Online: shown.Online, Places: places, shown: shown}
	}
	return out
}

func printTexts(docs []textOut) {
	for _, d := range docs {
		var notes []string
		if !d.Online {
			notes = append(notes, "offline")
		}
		if d.shown.Missing {
			notes = append(notes, "missing")
		}
		if n := len(d.Places) - 1; n > 0 {
			notes = append(notes, fmt.Sprintf("%d more copies", n))
		}
		note := ""
		if len(notes) > 0 {
			note = "  (" + strings.Join(notes, ", ") + ")"
		}
		fmt.Printf("%10s  %s  %s%s\n    %s\n", humanBytes(d.shown.Size), shortDate(d.shown.Modified), d.Display, note, d.Snippet)
	}
}

// memberOut is a member as printed: inside the copy of its archive that can
// be opened now, or the first present one.
type memberOut struct {
	store.MemberHit
	Display string   `json:"display"`
	Online  bool     `json:"online"`
	Archive []hitOut `json:"archive"`
	shown   hitOut
}

func outMembers(members []store.MemberHit, roots map[string]string) []memberOut {
	out := make([]memberOut, len(members))
	for i, m := range members {
		copies := outHits(m.Archive, roots)
		out[i] = memberOut{MemberHit: m, Archive: copies}
		if len(copies) == 0 {
			continue
		}
		shown := bestCopy(copies)
		out[i].shown = shown
		out[i].Display = shown.Display + archive.Separator + filepath.FromSlash(m.Path)
		out[i].Online = shown.Online
	}
	return out
}

func printMembers(members []memberOut) error {
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', tabwriter.AlignRight)
	for _, m := range members {
		size := humanBytes(m.Size)
		if m.Kind != "file" {
			size = m.Kind
		}
		var notes []string
		if !m.Online {
			notes = append(notes, "offline")
		}
		if m.shown.Missing {
			notes = append(notes, "missing")
		}
		if m.Encrypted {
			notes = append(notes, "encrypted")
		}
		if n := len(m.Archive) - 1; n > 0 {
			notes = append(notes, fmt.Sprintf("%d more copies", n))
		}
		note := ""
		if len(notes) > 0 {
			note = "  (" + strings.Join(notes, ", ") + ")"
		}
		fmt.Fprintf(tw, "%s\t%s\t  %s%s\n", size, shortDate(m.Modified), m.Display, note)
	}
	return tw.Flush()
}

// resolveUnder accepts a mounted folder (E:\Files) or a volume-relative one
// (/Files) together with --volume.
func resolveUnder(under, volumeID string, vols []store.Volume) (string, string, error) {
	if strings.HasPrefix(under, "/") {
		if volumeID == "" {
			return "", "", errors.New("--under /path needs --volume; or give a mounted folder such as E:\\Files")
		}
		return strings.TrimSuffix(under, "/"), volumeID, nil
	}
	mounted, rel, err := disk.Locate(under)
	if err != nil {
		return "", "", err
	}
	for _, v := range vols {
		if v.Holds(mounted.Fingerprint) && (volumeID == "" || volumeID == v.ID) {
			p := ""
			for _, part := range rel {
				p += "/" + part
			}
			return p, v.ID, nil
		}
	}
	return "", "", fmt.Errorf("%s is on a volume attic has not scanned", under)
}

func cmdShow(ctx context.Context, args []string) error {
	flagArgs, pos := interspersed(args, map[string]bool{"json": true})
	fs := flag.NewFlagSet("show", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(flagArgs)
	if len(pos) != 1 {
		return fmt.Errorf("show needs an entry id or a ref: %w", errUsage)
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	vols, err := st.KnownVolumes(ctx)
	if err != nil {
		return err
	}
	roots := onlineRoots(vols)

	if ref, ok := store.ParseRef(pos[0]); ok {
		c, err := st.Content(ctx, ref)
		if err != nil {
			return err
		}
		places := outHits(c.Occurrences, roots)
		if *asJSON {
			return printJSON(struct {
				store.ContentDetail
				Occurrences []hitOut `json:"occurrences"`
			}{c, places})
		}
		fmt.Printf("attic:%s  %s, first seen %s\n  blake3  %s\n", c.Ref, humanBytes(c.Size), c.FirstSeen.Local().Format("2006-01-02"), c.BLAKE3)
		return printHits(places)
	}

	id, err := strconv.ParseInt(pos[0], 10, 64)
	if err != nil {
		return fmt.Errorf("not an entry id or a ref: %q", pos[0])
	}
	d, err := st.Entry(ctx, id)
	if err != nil {
		return err
	}
	root, online := roots[d.VolumeID]
	copies := outHits(d.Copies, roots)
	if *asJSON {
		return printJSON(struct {
			store.EntryDetail
			Display string   `json:"display"`
			Online  bool     `json:"online"`
			Copies  []hitOut `json:"copies,omitempty"`
		}{d, displayPath(d.VolumeID, d.Volume, d.Path, roots), online, copies})
	}
	fmt.Println(displayPath(d.VolumeID, d.Volume, d.Path, roots))
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	where := "offline"
	if online {
		where = "online at " + root
	}
	fmt.Fprintf(tw, "  id\t%d\n  volume\t%s, %s\n", d.ID, d.Volume, where)
	if d.Kind == "file" {
		fmt.Fprintf(tw, "  size\t%s (%s bytes)\n", humanBytes(d.Size), count(d.Size))
	} else {
		fmt.Fprintf(tw, "  kind\t%s\n", d.Kind)
	}
	fmt.Fprintf(tw, "  modified\t%s\n  created\t%s\n  accessed\t%s\n", stamp(d.Modified), stamp(d.Created), stamp(d.Accessed))
	if d.Ref != "" {
		fmt.Fprintf(tw, "  ref\tattic:%s\n", d.Ref)
	} else if d.Kind == "file" {
		fmt.Fprintf(tw, "  hash\t%s\n", d.HashState)
	}
	if a := d.Archive; a != nil {
		switch a.Status {
		case archive.Listed:
			fmt.Fprintf(tw, "  archive\t%s, %s members\n", a.Format, count(a.Members))
		case archive.NotArchive:
			fmt.Fprintf(tw, "  archive\tnot an archive\n")
		default:
			fmt.Fprintf(tw, "  archive\t%s, %s, %s members read: %s\n", a.Format, a.Status, count(a.Members), a.Detail)
		}
	}
	if t := d.Text; t != nil {
		switch t.Status {
		case "ok":
			fmt.Fprintf(tw, "  text\t%s characters (attic text %d)\n", count(t.Chars), d.ID)
		case "truncated":
			fmt.Fprintf(tw, "  text\tthe first %s characters; the rest was cut (attic text %d)\n", count(t.Chars), d.ID)
		default:
			fmt.Fprintf(tw, "  text\t%s %s\n", t.Status, t.Detail)
		}
	}
	if m := d.Metadata; m != nil {
		fmt.Fprintf(tw, "  metadata\t%s, %d tags (attic metadata %d)\n", m.Status, len(m.Tags), d.ID)
	}
	if d.GitRemote != nil {
		remote := *d.GitRemote
		if remote == "" {
			remote = "(no origin)"
		}
		fmt.Fprintf(tw, "  git\t%s\n", remote)
	}
	fmt.Fprintf(tw, "  seen\tfirst %s, changed %s\n", d.FirstSeen.Local().Format("2006-01-02"), d.Updated.Local().Format("2006-01-02"))
	if d.MissingAt != nil {
		fmt.Fprintf(tw, "  missing\tsince the scan of %s\n", stamp(d.MissingAt))
	}
	if err := tw.Flush(); err != nil || len(copies) == 0 {
		return err
	}
	fmt.Printf("  also stored at:\n")
	return printHits(copies)
}

func cmdVolumes(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("volumes", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(args)
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	vols, err := st.Volumes(ctx)
	if err != nil {
		return err
	}
	known := make([]store.Volume, len(vols))
	for i, v := range vols {
		known[i] = v.Volume
	}
	roots := onlineRoots(known)
	if *asJSON {
		type volumeOut struct {
			store.VolumeSummary
			MountedAt string `json:"mounted_at,omitempty"`
		}
		out := make([]volumeOut, len(vols))
		for i, v := range vols {
			out[i] = volumeOut{v, roots[v.ID]}
		}
		return printJSON(out)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tLABEL\tFS\tMOUNTED\tFILES\tSIZE\tHASHED\tPENDING\tMISSING\tLAST SCAN")
	for _, v := range vols {
		mounted := roots[v.ID]
		if mounted == "" {
			mounted = "-"
		}
		last := "-"
		if v.LastScan != nil {
			last = fmt.Sprintf("%s %s (%d)", v.LastScan.Started.Local().Format("2006-01-02"), v.LastScan.Status, v.LastScan.ID)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", v.ID, v.Label, v.FS, mounted, count(v.Files),
			humanBytes(v.Bytes), count(v.Hashed), count(v.Pending), count(v.Missing), last)
	}
	return tw.Flush()
}

func cmdDupes(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("dupes", flag.ExitOnError)
	minSize := fs.String("min-size", "1M", "")
	sameVolume := fs.Bool("same-volume", false, "")
	limit := fs.Int("limit", 20, "")
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(args)
	floor, err := parseSize(*minSize)
	if err != nil {
		return err
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	dupes, wasted, err := st.Dupes(ctx, floor, *sameVolume, *limit)
	if err != nil {
		return err
	}
	vols, err := st.KnownVolumes(ctx)
	if err != nil {
		return err
	}
	roots := onlineRoots(vols)
	if *asJSON {
		type dupeOut struct {
			store.Dupe
			Places []hitOut `json:"places"`
		}
		out := struct {
			Wasted int64     `json:"wasted"`
			Dupes  []dupeOut `json:"dupes"`
		}{Wasted: wasted, Dupes: make([]dupeOut, len(dupes))}
		for i, d := range dupes {
			out.Dupes[i] = dupeOut{d, outHits(d.Places, roots)}
		}
		return printJSON(out)
	}
	if len(dupes) == 0 {
		fmt.Println("no content of that size is stored twice")
		return nil
	}
	fmt.Printf("copies beyond the first take %s in total; the largest:\n", humanBytes(wasted))
	for _, d := range dupes {
		fmt.Printf("\n%s x %d, attic:%s\n", humanBytes(d.Size), d.Copies, d.Ref)
		if err := printHits(outHits(d.Places, roots)); err != nil {
			return err
		}
	}
	return nil
}

func cmdSkips(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("skips", flag.ExitOnError)
	scanID := fs.Int64("scan", 0, "")
	volume := fs.String("volume", "", "")
	reason := fs.String("reason", "", "")
	rule := fs.String("rule", "", "")
	limit := fs.Int("limit", 100, "")
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(args)
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	var sc store.ScanInfo
	switch {
	case *scanID != 0:
		sc, err = st.ScanByID(ctx, *scanID)
	case *volume != "":
		var v store.Volume
		if v, err = st.FindVolume(ctx, *volume); err == nil {
			sc, err = st.LatestScan(ctx, v.ID)
		}
	default:
		sc, err = st.LatestScan(ctx, "")
	}
	if err != nil {
		return err
	}
	if *reason != "" || *rule != "" {
		skips, err := st.Skips(ctx, sc.ID, *reason, *rule, *limit)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(skips)
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		for _, s := range skips {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", s.Path, s.Reason, s.Rule, s.Detail)
		}
		return tw.Flush()
	}
	groups, err := st.SkipGroups(ctx, sc.ID)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(struct {
			Scan   store.ScanInfo    `json:"scan"`
			Groups []store.SkipGroup `json:"groups"`
		}{sc, groups})
	}
	root := sc.Root
	if root == "" {
		root = "/"
	}
	fmt.Printf("scan %d of %s (%s, %s): %s skipped\n", sc.ID, root, sc.Status, sc.Started.Local().Format("2006-01-02 15:04"), count(sc.Skipped))
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	for _, g := range groups {
		fmt.Fprintf(tw, "  %s\t%s\t%s\te.g. %s\n", count(g.Count), g.Reason, g.Rule, g.Example)
	}
	return tw.Flush()
}

func cmdStats(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(args)
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	t, err := st.Totals(ctx)
	if err != nil {
		return err
	}
	analyses, err := st.AITotals(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(struct {
			store.Totals
			Analyses map[string]int64 `json:"analyses"`
		}{t, analyses})
	}
	fmt.Printf("%s volumes, %s entries, %s files, %s\n", count(t.Volumes), count(t.Entries), count(t.Files), humanBytes(t.Bytes))
	fmt.Printf("%s unique contents, %s; %s files left to hash, %s entries missing\n",
		count(t.Contents), humanBytes(t.ContentBytes), count(t.Pending), count(t.Missing))
	fmt.Printf("%s archives read, %s members inside\n", count(t.Archives), count(t.Members))
	fmt.Printf("%s files with metadata extracted\n", count(t.Metadata))
	for _, key := range slices.Sorted(maps.Keys(analyses)) {
		fmt.Printf("%s %s enrichment results\n", count(analyses[key]), key)
	}
	var docs []string
	var read int64
	for _, status := range slices.Sorted(maps.Keys(t.Texts)) {
		docs = append(docs, count(t.Texts[status])+" "+status)
		read += t.Texts[status]
	}
	fmt.Printf("%s documents (%s), %s characters of text\n", count(read), strings.Join(docs, ", "), count(t.TextChars))
	return nil
}

func cmdText(ctx context.Context, args []string) error {
	flagArgs, pos := interspersed(args, map[string]bool{"json": true})
	fs := flag.NewFlagSet("text", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(flagArgs)
	if len(pos) != 1 {
		return fmt.Errorf("text needs an entry id or a ref: %w", errUsage)
	}
	var id int64
	ref, isRef := store.ParseRef(pos[0])
	if !isRef {
		var err error
		if id, err = strconv.ParseInt(pos[0], 10, 64); err != nil {
			return fmt.Errorf("not an entry id or a ref: %q", pos[0])
		}
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	d, err := st.Text(ctx, id, ref)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(d)
	}
	if d.Text == "" {
		return fmt.Errorf("attic:%s has no text: %s %s", d.Ref, d.Status, d.Detail)
	}
	fmt.Println(d.Text)
	return nil
}

func cmdConfig(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("config", flag.ExitOnError)
	configPath := fs.String("config", "", "")
	volume := fs.String("volume", "", "")
	_ = fs.Parse(args)
	cfg, path, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	state := "exists"
	if _, err := os.Stat(path); err != nil {
		state = "not created; defaults apply"
	}
	fmt.Printf("config    %s (%s)\n", path, state)
	if cfg.HashMaxBytes > 0 {
		fmt.Printf("hash      files up to %s\n", humanBytes(cfg.HashMaxBytes))
	} else {
		fmt.Println("hash      every file")
	}
	if a := cfg.Archives; a.Depth == 0 {
		fmt.Println("archives  not read")
	} else {
		limit, temp := "any size", a.Temp
		if a.UnpackMaxBytes > 0 {
			limit = "up to " + humanBytes(a.UnpackMaxBytes)
		}
		if temp == "" {
			temp = os.TempDir()
		}
		fmt.Printf("archives  %d levels deep; nested archives %s, unpacked in %s\n", a.Depth, limit, temp)
	}
	if t := cfg.Text; t.MaxBytes > 0 {
		fmt.Printf("text      documents up to %s, the first 1 MB of text each\n", humanBytes(t.MaxBytes))
	} else {
		fmt.Println("text      documents of any size, the first 1 MB of text each")
	}
	fmt.Printf("metadata  enabled=%t, exiftool=%s, max_bytes=%d, temp=%s\n", cfg.Metadata.Enabled, cfg.Metadata.ExifTool, cfg.Metadata.MaxBytes, cmp.Or(cfg.Metadata.Temp, cfg.Archives.Temp, os.TempDir()))
	fmt.Printf("enrich    explicit command only; provider=%s, model=%s, endpoint=%s, api_key_env=%s, max_bytes=%d, timeout=%ds, temp=%s\n", cfg.AI.Provider, cfg.AI.Model, cfg.AI.Endpoint, cfg.AI.APIKeyEnv, cfg.AI.MaxBytes, cfg.AI.TimeoutSeconds, cmp.Or(cfg.AI.Temp, cfg.Archives.Temp, os.TempDir()))
	exclude, nameOnly := cfg.Rules(*volume, *volume).Describe()
	fmt.Println("exclude")
	for _, r := range exclude {
		fmt.Println("  " + r)
	}
	fmt.Println("name only")
	for _, r := range nameOnly {
		fmt.Println("  " + r)
	}
	return nil
}

func cmdScans(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("scans", flag.ExitOnError)
	volume := fs.String("volume", "", "")
	limit := fs.Int("limit", 20, "")
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(args)
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	volumeID := ""
	if *volume != "" {
		v, err := st.FindVolume(ctx, *volume)
		if err != nil {
			return err
		}
		volumeID = v.ID
	}
	scans, err := st.Scans(ctx, volumeID, *limit)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(scans)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tVOLUME\tROOT\tSTATUS\tSTARTED\tTOOK\tHASHED\tARCHIVES\tDOCUMENTS\tSKIPPED\tPHASES")
	for _, s := range scans {
		took := "running"
		if s.Finished != nil {
			took = s.Finished.Sub(s.Started).Round(time.Second).String()
		}
		fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", s.ID, s.Volume, cmp.Or(s.Root, "/"), s.Status,
			s.Started.Local().Format("2006-01-02 15:04"), took, humanBytes(s.HashedBytes), count(s.Archives),
			count(s.Texts), count(s.Skipped), phaseSummary(s.Phases, s.HashedBytes))
	}
	return tw.Flush()
}

func cmdMetadata(ctx context.Context, args []string) error {
	flags, pos := interspersed(args, map[string]bool{"json": true})
	fs := flag.NewFlagSet("metadata", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	_ = fs.Parse(flags)
	if len(pos) != 1 {
		return fmt.Errorf("metadata needs an entry id or a ref: %w", errUsage)
	}
	var id int64
	ref, isRef := store.ParseRef(pos[0])
	if !isRef {
		var err error
		if id, err = strconv.ParseInt(pos[0], 10, 64); err != nil {
			return fmt.Errorf("not an entry id or a ref: %q", pos[0])
		}
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	d, err := st.Metadata(ctx, id, ref)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(d)
	}
	fmt.Printf("attic:%s: %s\n", d.Ref, d.Status)
	if d.Detail != "" {
		fmt.Println(d.Detail)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	for _, key := range slices.Sorted(maps.Keys(d.Tags)) {
		fmt.Fprintf(tw, "%s\t%v\n", key, d.Tags[key])
	}
	return tw.Flush()
}
