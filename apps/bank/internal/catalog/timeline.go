package catalog

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Dated is the archive's side of the timeline.
type Dated interface {
	MessagesBetween(ctx context.Context, since, until time.Time, limit int) ([]store.Dated, error)
	ActivityBetween(ctx context.Context, since, until time.Time, limit int) ([]store.Dated, error)
}

// Files is the catalogue's side: files on disks by modification time.
type Files interface {
	ModifiedFiles(ctx context.Context, since, until time.Time, limit int) ([]view.Place, error)
}

// Catalogue is everything combined answers ask of the file catalogue.
type Catalogue interface {
	Disks
	Files
}

// Event is one thing that happened: a message sent, something watched,
// listened to or read, or a file last modified.
type Event struct {
	At        time.Time `json:"at" doc:"When it happened. Midnight when precision is day."`
	Precision string    `json:"precision" enum:"instant,day" doc:"day when the source recorded a date without a time."`
	Group     string    `json:"group" enum:"message,activity,file" doc:"Which records the event comes from."`
	Kind      string    `json:"kind" doc:"message, the activity kind such as watch or listen, or file."`
	Source    string    `json:"source" doc:"The message or activity source, such as gmail or netflix, or the disk's label."`
	Ref       string    `json:"ref" doc:"What to cite and resolve: bank:<ref> for a message, an activity ID, or attic:<ref> for a hashed file."`
	Title     string    `json:"title" doc:"Subject or opening words, the activity's title, or the file's path."`
}

type Timeline struct {
	Events    []Event  `json:"events" doc:"Oldest first."`
	Truncated []string `json:"truncated" doc:"Groups that reached limit; narrow the dates or ask for one group to see the rest."`
	Coverage  []string `json:"coverage" doc:"What this answer leaves out and why."`
}

// TimelineGroups are the values of TimelineOptions.Groups, in display order.
var TimelineGroups = []string{"message", "activity", "file"}

type TimelineOptions struct {
	// Since is the first day and Until the day after the last.
	Since, Until time.Time
	// Groups limits the answer; empty means every group.
	Groups []string
	// Limit caps each group, so a day with thousands of files cannot push
	// the messages out.
	Limit int
}

// BuildTimeline merges what happened in the window, oldest first. files may be nil.
func BuildTimeline(ctx context.Context, dated Dated, files Files, o TimelineOptions) (Timeline, error) {
	out := Timeline{Events: []Event{}, Truncated: []string{}, Coverage: []string{}}
	if o.Since.IsZero() || !o.Until.After(o.Since) {
		return out, fmt.Errorf("the timeline needs since and a later until")
	}
	for _, group := range o.Groups {
		if !slices.Contains(TimelineGroups, group) {
			return out, fmt.Errorf("unknown timeline group %q", group)
		}
	}
	wants := func(group string) bool { return len(o.Groups) == 0 || slices.Contains(o.Groups, group) }
	add := func(group string, rows []store.Dated) {
		if len(rows) >= o.Limit {
			out.Truncated = append(out.Truncated, group)
		}
		for _, r := range rows {
			e := Event{At: r.At, Precision: "instant", Group: group, Kind: r.Kind, Source: r.Source, Ref: r.Ref, Title: r.Title}
			if r.Day {
				e.Precision = "day"
			}
			if group == "message" {
				e.Ref = "bank:" + r.Ref
			}
			out.Events = append(out.Events, e)
		}
	}
	if wants("message") {
		rows, err := dated.MessagesBetween(ctx, o.Since, o.Until, o.Limit)
		if err != nil {
			return out, err
		}
		add("message", rows)
	}
	if wants("activity") {
		rows, err := dated.ActivityBetween(ctx, o.Since, o.Until, o.Limit)
		if err != nil {
			return out, err
		}
		add("activity", rows)
		out.Coverage = append(out.Coverage, "Activity an export recorded without a date is left out.")
	}
	if wants("file") {
		switch places, err := modified(ctx, files, o); {
		case err != nil:
			// The archive answers without the catalogue, which may still be migrating.
			out.Coverage = append(out.Coverage, "Files on disks are missing from this timeline: "+err.Error()+".")
		default:
			if len(places) >= o.Limit {
				out.Truncated = append(out.Truncated, "file")
			}
			for _, p := range places {
				e := Event{At: *p.Modified, Precision: "instant", Group: "file", Kind: "file", Source: p.Volume, Title: p.Display}
				if p.Ref != "" {
					e.Ref = "attic:" + p.Ref
				}
				out.Events = append(out.Events, e)
			}
			out.Coverage = append(out.Coverage, "A file appears at its last modification, as its disk recorded it; earlier edits and files that have since gone missing are left out.")
		}
	}
	slices.SortStableFunc(out.Events, func(a, b Event) int { return a.At.Compare(b.At) })
	return out, nil
}

func modified(ctx context.Context, files Files, o TimelineOptions) ([]view.Place, error) {
	if files == nil {
		return nil, fmt.Errorf("this server has no file catalogue")
	}
	return files.ModifiedFiles(ctx, o.Since, o.Until, o.Limit)
}
