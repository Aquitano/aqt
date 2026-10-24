package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"

	"github.com/aquitano/aqt/apps/attic/internal/ai"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/enrich"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

type enrichCmd struct {
	Targets  []string `arg:"" optional:"" name:"ids-or-refs" help:"Selected entry IDs or content refs."`
	Task     string   `required:"" enum:"ocr,describe" help:"Enrichment task: ocr or describe."`
	Provider string   `enum:"tesseract,openai,codex," default:"" help:"Provider; defaults to tesseract for OCR and openai for descriptions."`
	Model    string   `help:"Explicit vision model for openai or codex."`
	Endpoint string   `help:"OpenAI-compatible base URL."`
	Config   string   `help:"Configuration file."`
	Under    string   `help:"Select files below this folder."`
	Volume   string   `help:"Volume label or ID."`
	Limit    int      `default:"20" help:"Maximum provider calls: 1 to 1000, or 20 for Codex."`
	Force    bool     `help:"Repeat successful work for this model and prompt."`
	JSON     bool     `help:"Print JSON."`
}

func (cmd *enrichCmd) Run(ctx context.Context) error {
	if len(cmd.Targets) == 0 && cmd.Under == "" {
		return errors.New("enrich needs entry ids, refs, or --under; first select files with attic search")
	}
	selection := store.AISelection{Force: cmd.Force}
	for _, arg := range cmd.Targets {
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
	cfg, _, err := loadConfig(cmd.Config)
	if err != nil {
		return err
	}
	if cmd.Provider != "" {
		cfg.AI.Provider = cmd.Provider
	}
	if cmd.Model != "" {
		cfg.AI.Model = cmd.Model
	}
	if cmd.Endpoint != "" {
		cfg.AI.Endpoint = cmd.Endpoint
	}
	if err := enrich.ValidateLimit(cfg.AI.Provider, cmd.Limit); err != nil {
		return err
	}
	p, err := ai.New(ctx, cfg.AI, cmd.Task)
	if err != nil {
		return err
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
	if cmd.Volume != "" {
		v, err := st.FindVolume(ctx, cmd.Volume)
		if err != nil {
			return err
		}
		volumeID = v.ID
	}
	if cmd.Under != "" {
		selection.Under, volumeID, err = resolveUnder(cmd.Under, volumeID, vols)
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
	fmt.Fprintf(os.Stderr, "%s using %s / %s; at most %d contents\n", p.Key().Task, p.Key().Provider, p.Key().Model, cmd.Limit)
	summary, runErr := enrich.Run(ctx, st, enrich.Options{Config: cfg, Provider: p, Selection: selection, Mounts: mounts, Limit: cmd.Limit, Progress: func(f store.ContentFile, status string) {
		fmt.Fprintf(os.Stderr, "attic:%s  %s: %s\n", f.Ref, f.Path, status)
	}})
	if cmd.JSON {
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

type analysisCmd struct {
	Target string `arg:"" name:"id-or-ref" help:"Entry ID or content ref."`
	JSON   bool   `help:"Print JSON."`
}

func (cmd *analysisCmd) Run(ctx context.Context) error {
	id, ref, err := parseTarget(cmd.Target)
	if err != nil {
		return err
	}
	st, err := openReadOnlyStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	results, err := st.Analyses(ctx, id, ref)
	if err != nil {
		return err
	}
	if cmd.JSON {
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
