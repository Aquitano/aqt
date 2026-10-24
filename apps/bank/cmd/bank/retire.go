package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type retireCmd struct {
	Source         string   `required:"" help:"Source whose messages are retired."`
	ExternalPrefix []string `required:"" name:"external-prefix" sep:"none" help:"Retire messages whose external id starts with this; repeatable."`
	ReplacementMap string   `name:"replacement-map" help:"JSON object or CSV (ref,replacement) of old ref to library id."`
	Reason         string   `help:"Recorded on every tombstone."`
	Apply          bool     `help:"Delete the rows and write tombstones; without it, a dry run."`
	JSON           bool     `help:"JSON output."`
}

func (c *retireCmd) Run(ctx context.Context) error {
	if client.FromEnv() != nil {
		return fmt.Errorf("retire deletes rows from the server's own database; run it there, not through BANK_URL")
	}
	var replacements map[string]string
	if c.ReplacementMap != "" {
		var err error
		if replacements, err = readReplacementMap(c.ReplacementMap); err != nil {
			return fmt.Errorf("%s: %w", c.ReplacementMap, err)
		}
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	res, err := st.RetireMessages(ctx, store.RetireOptions{
		Source: c.Source, ExternalPrefixes: c.ExternalPrefix, Replacements: replacements, Reason: c.Reason, Apply: c.Apply,
	})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(res)
	}
	for _, p := range res.Prefixes {
		fmt.Printf("%s %q: %s, %s\n", res.Source, p.Prefix, plural(int(p.Messages), "message"), plural(int(p.Attachments), "attachment"))
		for _, m := range p.Samples {
			fmt.Printf("  %s  %s  %s  %s", m.Ref, m.SentAt.Format(time.DateOnly), m.ExternalID, excerpt(m.Subject, 60))
			if m.Replacement != "" {
				fmt.Printf("  -> %s", m.Replacement)
			}
			fmt.Println()
		}
	}
	if replacements != nil {
		fmt.Printf("replacement map: %d of %d refs match a retiring message\n", res.Replaced, len(replacements))
		for _, ref := range res.UnmatchedReplacements {
			fmt.Printf("  unmatched: %s\n", ref)
		}
	}
	if !res.Applied {
		fmt.Printf("dry run: %s would be retired; pass --apply to delete them and write tombstones\n", plural(int(res.Messages), "message"))
		return nil
	}
	fmt.Printf("retired %s\n", plural(int(res.Retired), "message"))
	return nil
}

// readReplacementMap reads ref -> library id from a JSON object or a two-column
// CSV, with or without a header row.
func readReplacementMap(path string) (map[string]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	if strings.EqualFold(filepath.Ext(path), ".json") {
		return out, json.Unmarshal(raw, &out)
	}
	reader := csv.NewReader(bytes.NewReader(raw))
	reader.FieldsPerRecord = 2
	reader.TrimLeadingSpace = true
	for line := 1; ; line++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		ref, id := strings.TrimSpace(record[0]), strings.TrimSpace(record[1])
		if line == 1 && store.ValidRef(ref) != nil {
			continue
		}
		if previous, ok := out[ref]; ok && previous != id {
			return nil, fmt.Errorf("line %d: %s maps to both %s and %s", line, ref, previous, id)
		}
		out[ref] = id
	}
}
