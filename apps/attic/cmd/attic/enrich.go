package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"

	"github.com/aquitano/aqt/apps/attic/internal/ai"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/enrich"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func cmdEnrich(ctx context.Context, args []string) error {
	flags, pos := interspersed(args, map[string]bool{"json": true, "force": true})
	fs := flag.NewFlagSet("enrich", flag.ContinueOnError)
	task := fs.String("task", "", "ocr or describe")
	provider := fs.String("provider", "", "tesseract, openai or codex")
	model := fs.String("model", "", "explicit vision model")
	endpoint := fs.String("endpoint", "", "OpenAI-compatible base URL")
	configPath := fs.String("config", "", "configuration file")
	under := fs.String("under", "", "selected folder")
	volume := fs.String("volume", "", "volume label or id")
	limit := fs.Int("limit", 20, "maximum provider calls (1–1000; Codex at most 20)")
	force := fs.Bool("force", false, "rerun previously successful results")
	asJSON := fs.Bool("json", false, "JSON summary")
	if err := fs.Parse(flags); err != nil {
		return err
	}
	if len(pos) == 0 && *under == "" {
		return errors.New("enrich needs entry ids, refs, or --under; first select files with attic search")
	}
	if *limit < 1 || *limit > 1000 {
		return errors.New("limit must be between 1 and 1000")
	}
	selection := store.AISelection{Force: *force}
	for _, arg := range pos {
		id, ref, err := parseTarget(arg)
		if err != nil {
			return err
		}
		if id != 0 {
			selection.Entries = append(selection.Entries, id)
		} else {
			selection.Refs = append(selection.Refs, ref)
		}
	}
	cfg, _, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if *provider != "" {
		cfg.AI.Provider = *provider
	}
	if *model != "" {
		cfg.AI.Model = *model
	}
	if *endpoint != "" {
		cfg.AI.Endpoint = *endpoint
	}
	p, err := ai.New(ctx, cfg.AI, *task)
	if err != nil {
		return err
	}
	if p.Key().Provider == "codex" && *limit > 20 {
		return errors.New("Codex enrichment is limited to 20 contents per run")
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
	volumeID := ""
	if *volume != "" {
		v, err := st.FindVolume(ctx, *volume)
		if err != nil {
			return err
		}
		volumeID = v.ID
	}
	if *under != "" {
		selection.Under, volumeID, err = resolveUnder(*under, volumeID, vols)
		if err != nil {
			return err
		}
	}
	mounts := map[string]disk.Volume{}
	for _, m := range disk.Mounted() {
		for _, v := range vols {
			if (volumeID == "" || volumeID == v.ID) && v.Holds(m.Fingerprint) {
				mounts[v.ID] = m
			}
		}
	}
	fmt.Fprintf(os.Stderr, "%s using %s / %s; at most %d contents\n", p.Key().Task, p.Key().Provider, p.Key().Model, *limit)
	summary, runErr := enrich.Run(ctx, st, enrich.Options{Config: cfg, Provider: p, Selection: selection, Mounts: mounts, Limit: *limit, Progress: func(f store.ContentFile, status string) {
		fmt.Fprintf(os.Stderr, "attic:%s  %s: %s\n", f.Ref, f.Path, status)
	}})
	if *asJSON {
		err = printJSON(summary)
	} else {
		fmt.Printf("%d attempted, %d saved, %d failed, %d skipped\n", summary.Attempted, summary.Saved, summary.Failed, summary.Skipped)
	}
	if runErr == nil && summary.Failed > 0 {
		runErr = errors.New("some enrichments failed; rerun to continue pending work, then retry failures")
	}
	return errors.Join(runErr, err)
}

func parseTarget(arg string) (int64, string, error) {
	if ref, ok := store.ParseRef(arg); ok {
		return 0, ref, nil
	}
	id, err := strconv.ParseInt(arg, 10, 64)
	if err != nil || id <= 0 {
		return 0, "", fmt.Errorf("not an entry id or a ref: %q", arg)
	}
	return id, "", nil
}

func cmdAnalysis(ctx context.Context, args []string) error {
	flags, pos := interspersed(args, map[string]bool{"json": true})
	fs := flag.NewFlagSet("analysis", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "JSON output")
	if err := fs.Parse(flags); err != nil {
		return err
	}
	if len(pos) != 1 {
		return errors.New("analysis needs one entry id or ref")
	}
	id, ref, err := parseTarget(pos[0])
	if err != nil {
		return err
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	results, err := st.Analyses(ctx, id, ref)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(results)
	}
	if len(results) == 0 {
		return errors.New("no enrichment results for that content")
	}
	for _, a := range results {
		fmt.Printf("attic:%s  %s / %s / %s (%s, %d ms)\n  policy %s\n", a.Ref, a.Task, a.Provider, a.Model, a.Status, a.ElapsedMS, a.PromptVersion)
		if a.ReportedModel != "" {
			fmt.Printf("  reported model %s\n", a.ReportedModel)
		}
		if a.Detail != "" {
			fmt.Println(a.Detail)
		}
		fmt.Println(a.Text)
	}
	return nil
}

type analysisOut struct {
	textOut
	ai.Key
}

func outAnalyses(hits []store.AIHit, roots map[string]string) []analysisOut {
	out := make([]analysisOut, len(hits))
	for i, h := range hits {
		out[i] = analysisOut{textOut: outTexts([]store.TextHit{h.TextHit}, roots)[0], Key: h.Key}
	}
	return out
}
