package main

import (
	"context"
	"fmt"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/server"
)

type timelineCmd struct {
	Period string   `arg:"" help:"A year (2019), a month (2019-03) or a day (2019-03-14)."`
	Group  []string `help:"Only these groups: message, activity, file." enum:"message,activity,file"`
	Limit  int      `default:"200" help:"Maximum events per group."`
	JSON   bool     `help:"JSON output."`
}

// period reads a year, month or day as the half-open range of days it covers.
func period(s string) (since, until time.Time, err error) {
	for _, form := range []struct {
		layout              string
		years, months, days int
	}{{"2006", 1, 0, 0}, {"2006-01", 0, 1, 0}, {time.DateOnly, 0, 0, 1}} {
		if since, err = time.ParseInLocation(form.layout, s, time.Local); err == nil {
			return since, since.AddDate(form.years, form.months, form.days), nil
		}
	}
	return since, until, fmt.Errorf("%q is not a year, a month (YYYY-MM) or a day (YYYY-MM-DD)", s)
}

func (c *timelineCmd) Run(ctx context.Context) error {
	since, until, err := period(c.Period)
	if err != nil {
		return err
	}
	var result catalog.Timeline
	if remote := client.FromEnv(); remote != nil {
		result, err = remote.Timeline(ctx, since, until, c.Group, c.Limit)
	} else {
		st, openErr := openStore(ctx)
		if openErr != nil {
			return openErr
		}
		defer st.Close()
		// A database without the catalogue answers from the archive alone.
		var files catalog.Files
		if catalogue, openErr := attic.Open(ctx, databaseURL()); openErr == nil {
			defer catalogue.Close()
			files = catalogue
		}
		result, err = catalog.BuildTimeline(ctx, st, files, catalog.TimelineOptions{Since: since, Until: until, Groups: c.Group, Limit: c.Limit})
	}
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(result)
	}
	for _, e := range result.Events {
		at := e.At.Local().Format("2006-01-02 15:04")
		if e.Precision == "day" {
			at = e.At.Local().Format("2006-01-02      ")
		}
		fmt.Printf("%s  %-8s %-12s %s  %s\n", at, e.Kind, e.Source, e.Ref, excerpt(e.Title, 100))
	}
	if len(result.Events) == 0 {
		fmt.Println("nothing recorded in that period")
	}
	for _, group := range result.Truncated {
		fmt.Printf("\n… more %s events than --limit %d; narrow the period or use --group %s\n", group, c.Limit, group)
	}
	for _, note := range result.Coverage {
		fmt.Printf("note: %s\n", note)
	}
	return nil
}

type refCmd struct {
	Ref  string `arg:"" help:"The ref as cited."`
	JSON bool   `help:"JSON output."`
}

func (c *refCmd) Run(ctx context.Context) error {
	var resolved catalog.Resolved
	var err error
	if remote := client.FromEnv(); remote != nil {
		resolved, err = remote.Resolve(ctx, c.Ref)
	} else {
		st, openErr := openStore(ctx)
		if openErr != nil {
			return openErr
		}
		defer st.Close()
		// A database without the catalogue resolves the archive's refs alone.
		var contents catalog.Contents
		if catalogue, openErr := attic.Open(ctx, databaseURL()); openErr == nil {
			defer catalogue.Close()
			contents = catalogue
		}
		resolved, err = catalog.Resolve(ctx, st, contents, c.Ref)
	}
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(resolved)
	}
	fmt.Printf("%s  %s  %s\n", resolved.Kind, resolved.Ref, resolved.Title)
	if resolved.At != nil {
		fmt.Printf("  at    %s\n", resolved.At.Local().Format("2006-01-02 15:04"))
	}
	fmt.Printf("  full  %s\n", resolved.Href)
	for _, link := range resolved.Links {
		fmt.Printf("  %-11s %s  %s\n", link.Relation, link.Ref, link.Title)
	}
	return nil
}

type openapiCmd struct{}

func (openapiCmd) Run() error {
	spec, err := server.Spec()
	if err != nil {
		return err
	}
	_, err = fmt.Println(string(spec))
	return err
}
