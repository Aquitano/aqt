package media

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
)

var netflixSeason = regexp.MustCompile(`(?i):\s*(?:season|staffel|series|book|part)\s+(\d+)\s*:`)

// Netflix reads a "Viewing activity" CSV. Netflix exports have no native
// viewing ids, so a viewing is identified by its title, its date and its
// occurrence count for that pair within the export.
type Netflix struct{}

type NetflixOptions struct {
	Source    string `json:"source,omitempty" help:"Source name to file the records under (default netflix)."`
	Account   string `json:"account,omitempty" help:"Profile or account identity; keep it stable across imports."`
	DateOrder string `json:"date_order,omitempty" help:"Order of slash dates: mdy (default) or dmy."`
}

func (o *NetflixOptions) Normalize() error {
	if o.Source == "" {
		o.Source = "netflix"
	}
	if o.DateOrder == "" {
		o.DateOrder = "mdy"
	}
	if o.DateOrder != "mdy" && o.DateOrder != "dmy" {
		return fmt.Errorf("Netflix date order must be mdy or dmy")
	}
	return ingest.ValidSource(o.Source)
}

func (Netflix) Kind() string { return "netflix" }

func (n Netflix) Parse(_ context.Context, raw ingest.Raw, opts NetflixOptions, out ingest.Emitter) error {
	data, err := os.ReadFile(raw.Path)
	if err != nil {
		return err
	}
	name := raw.Name
	batch := emptyBatch()
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(data), "\ufeff")))
	header, err := r.Read()
	if err != nil {
		return fmt.Errorf("Netflix header: %w", err)
	}
	fields := csvFields(header)
	if _, ok := fields["title"]; !ok {
		return fmt.Errorf("Netflix CSV requires Title and Date columns")
	}
	if _, ok := fields["date"]; !ok {
		return fmt.Errorf("Netflix CSV requires Title and Date columns")
	}
	items := map[string]bool{}
	occurrences := map[string]int{}
	for row := 2; ; row++ {
		values, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("Netflix CSV row %d: %w", row, err)
		}
		title := csvValue(values, fields, "title")
		date, err := netflixDate(csvValue(values, fields, "date"), opts.DateOrder)
		if title == "" || err != nil {
			out.Issue(ingest.Issuef(ingest.Skipped, "%s: CSV row %d has an empty title or invalid date", name, row))
			continue
		}
		itemIdentity := identity(opts.Source, opts.Account, "title:"+fieldhash.Hex(title))
		itemID := library.StableID("item", itemIdentity)
		if !items[itemID] {
			item := library.Item{Identity: itemIdentity, ID: itemID, Kind: "other", Title: title, Creators: []string{}, FileIDs: []string{}, Provenance: provenance(name, fmt.Sprintf("CSV row %d", row))}
			if match := netflixSeason.FindStringSubmatchIndex(title); match != nil {
				n, _ := strconv.Atoi(title[match[2]:match[3]])
				item.Kind = "episode"
				item.Series = strings.TrimSpace(title[:match[0]])
				item.Season = &n
			}
			batch.Items = append(batch.Items, item)
			items[itemID] = true
		}
		viewing := fieldhash.Hex(title, date.Precision, date.Value)
		occurrences[viewing]++
		eventIdentity := identity(opts.Source, opts.Account, fmt.Sprintf("viewing:%s:occurrence:%d", viewing, occurrences[viewing]))
		batch.Activity = append(batch.Activity, library.Activity{Identity: eventIdentity, ID: library.StableID("activity", eventIdentity), ItemID: itemID, Kind: "watch", Title: title, Occurred: date, Provenance: provenance(name, fmt.Sprintf("CSV row %d", row))})
	}
	if len(batch.Activity) == 0 {
		return fmt.Errorf("Netflix CSV contained no usable viewing records")
	}
	return emitBatch(out, n.Kind(), batch)
}

func netflixDate(value, order string) (library.Date, error) {
	value = strings.TrimSpace(value)
	if strings.Contains(value, "/") {
		layouts := []string{"1/2/06", "1/2/2006"}
		if order == "dmy" {
			layouts = []string{"2/1/06", "2/1/2006"}
		}
		for _, layout := range layouts {
			if date, err := time.Parse(layout, value); err == nil {
				return library.Date{Value: date.Format("2006-01-02"), Precision: "day"}, nil
			}
		}
		return library.Date{}, fmt.Errorf("invalid %s Netflix date %q", order, value)
	}
	return exportDate(value)
}

func exportDate(value string) (library.Date, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return library.Date{Precision: "unknown"}, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return library.Date{Value: t.Format(time.RFC3339Nano), Precision: "instant"}, nil
	}
	for _, layout := range []string{"2006-01-02", "1/2/06", "1/2/2006", "02.01.2006"} {
		if t, err := time.Parse(layout, value); err == nil {
			return library.Date{Value: t.Format("2006-01-02"), Precision: "day"}, nil
		}
	}
	return library.Date{}, fmt.Errorf("unrecognized date %q", value)
}

func csvFields(header []string) map[string]int {
	fields := map[string]int{}
	for i, name := range header {
		fields[normalizeField(name)] = i
	}
	return fields
}
func normalizeField(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.ToLower(strings.TrimPrefix(value, "\ufeff")))
}
func csvValue(row []string, fields map[string]int, names ...string) string {
	for _, name := range names {
		if i, ok := fields[name]; ok && i < len(row) {
			if value := strings.TrimSpace(row[i]); value != "" {
				return value
			}
		}
	}
	return ""
}
