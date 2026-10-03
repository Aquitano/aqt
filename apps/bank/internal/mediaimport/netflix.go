package mediaimport

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
)

var netflixSeason = regexp.MustCompile(`(?i):\s*(?:season|staffel|series|book|part)\s+(\d+)\s*:`)

func parseNetflix(inputPath string, opts Options) (Parsed, error) {
	raw, err := os.ReadFile(inputPath)
	if err != nil {
		return Parsed{}, err
	}
	name := filepath.Base(inputPath)
	p := Parsed{Batch: emptyBatch(), Inputs: []RawInput{{Name: name, Bytes: raw}}, Diagnostics: []string{}}
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(raw), "\ufeff")))
	header, err := r.Read()
	if err != nil {
		return p, fmt.Errorf("Netflix header: %w", err)
	}
	fields := csvFields(header)
	if _, ok := fields["title"]; !ok {
		return p, fmt.Errorf("Netflix CSV requires Title and Date columns")
	}
	if _, ok := fields["date"]; !ok {
		return p, fmt.Errorf("Netflix CSV requires Title and Date columns")
	}
	items := map[string]bool{}
	sum := digest(raw)
	for row := 2; ; row++ {
		values, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return p, fmt.Errorf("Netflix CSV row %d: %w", row, err)
		}
		title := csvValue(values, fields, "title")
		date, err := exportDate(csvValue(values, fields, "date"))
		if title == "" || err != nil {
			p.Skipped++
			p.Diagnostics = append(p.Diagnostics, fmt.Sprintf("Netflix row %d skipped: empty title or invalid date", row))
			continue
		}
		itemIdentity := identity(opts, "title:"+digest([]byte(title)))
		itemID := library.StableID("item", itemIdentity)
		if !items[itemID] {
			item := library.Item{Identity: itemIdentity, ID: itemID, Kind: "other", Title: title, Creators: []string{}, FileIDs: []string{}, Provenance: provenance(name, fmt.Sprintf("CSV row %d", row))}
			if match := netflixSeason.FindStringSubmatchIndex(title); match != nil {
				n, _ := strconv.Atoi(title[match[2]:match[3]])
				item.Kind = "episode"
				item.Series = strings.TrimSpace(title[:match[0]])
				item.Season = &n
			}
			p.Batch.Items = append(p.Batch.Items, item)
			items[itemID] = true
		}
		eventIdentity := identity(opts, fmt.Sprintf("file:%s:row:%d", sum, row))
		p.Batch.Activity = append(p.Batch.Activity, library.Activity{Identity: eventIdentity, ID: library.StableID("activity", eventIdentity), ItemID: itemID, Kind: "watch", Title: title, Occurred: date, Provenance: provenance(name, fmt.Sprintf("CSV row %d", row))})
	}
	if len(p.Batch.Activity) == 0 {
		return p, fmt.Errorf("Netflix CSV contained no usable viewing records")
	}
	p.Diagnostics = append(p.Diagnostics, "Netflix exports have no native viewing IDs; identical-file replay is deduplicated, overlapping different exports can repeat activity. Viewing records do not establish completion.")
	return p, nil
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
