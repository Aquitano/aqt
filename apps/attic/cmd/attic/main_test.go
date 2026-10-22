package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestCLIParsesArguments(t *testing.T) {
	for _, tt := range []struct {
		args  []string
		check func(cli) bool
	}{
		{[]string{"search", "minecraft", "--ext", "rar", "server", "--json"}, func(c cli) bool {
			return reflect.DeepEqual(c.Search.Words, []string{"minecraft", "server"}) && c.Search.Ext == "rar" && c.Search.JSON && c.Search.Limit == 20
		}},
		{[]string{"search", "--json", "--", "-foo", "--ext"}, func(c cli) bool {
			return reflect.DeepEqual(c.Search.Words, []string{"-foo", "--ext"}) && c.Search.JSON && c.Search.Ext == ""
		}},
		{[]string{"search", "--volume", "-json", "notes"}, func(c cli) bool {
			return c.Search.Volume == "-json" && !c.Search.JSON && reflect.DeepEqual(c.Search.Words, []string{"notes"})
		}},
		{[]string{"search", "notes", "--limit", "-1", "more", "--ext", "-pdf"}, func(c cli) bool {
			return c.Search.Limit == -1 && c.Search.Ext == "-pdf" && reflect.DeepEqual(c.Search.Words, []string{"notes", "more"})
		}},
		{[]string{"search", "notes", "--ext="}, func(c cli) bool {
			return c.Search.Ext == "" && reflect.DeepEqual(c.Search.Words, []string{"notes"})
		}},
		{[]string{"search", "notes", "--ext", "--"}, func(c cli) bool {
			return c.Search.Ext == "--" && reflect.DeepEqual(c.Search.Words, []string{"notes"})
		}},
		{[]string{"config", "--config", "-settings.toml"}, func(c cli) bool {
			return c.Config.Config == "-settings.toml"
		}},
		{[]string{"config", "--config", "--volume"}, func(c cli) bool {
			return c.Config.Config == "--volume" && c.Config.Volume == ""
		}},
		{[]string{"config", "--config="}, func(c cli) bool {
			return c.Config.Config == ""
		}},
		{[]string{"config", "-volume", "Data"}, func(c cli) bool {
			return c.Config.Volume == "Data"
		}},
		{[]string{"search", "minecraft", "-ext=rar", "server", "-json"}, func(c cli) bool {
			return reflect.DeepEqual(c.Search.Words, []string{"minecraft", "server"}) && c.Search.Ext == "rar" && c.Search.JSON
		}},
		{[]string{"scan", `E:\Files`, "--no-hash"}, func(c cli) bool {
			return c.Scan.Folder == `E:\Files` && c.Scan.NoHash && c.Scan.LogLevel == "info"
		}},
		{[]string{"scan", `E:\Files`, "--rebuild-content"}, func(c cli) bool {
			return c.Scan.Folder == `E:\Files` && c.Scan.RebuildContent && !c.Scan.NoHash
		}},
		{[]string{"scan", `E:\Files`, "--no-hash=false", "--rebuild-content"}, func(c cli) bool {
			return c.Scan.RebuildContent && !c.Scan.NoHash
		}},
		{[]string{"scan", `E:\Files`, "--volume", "known", "--new-volume=false"}, func(c cli) bool {
			return c.Scan.Volume == "known" && !c.Scan.NewVolume
		}},
		{[]string{"enrich", "123", "attic:0123456789abcdef", "--task", "ocr", "--force"}, func(c cli) bool {
			return reflect.DeepEqual(c.Enrich.Targets, []string{"123", "attic:0123456789abcdef"}) && c.Enrich.Task == "ocr" && c.Enrich.Provider == "" && c.Enrich.Force && c.Enrich.Limit == 20
		}},
		{[]string{"metadata", "123", "--json"}, func(c cli) bool {
			return c.Metadata.Target == "123" && c.Metadata.JSON
		}},
		{[]string{"dupes"}, func(c cli) bool {
			return c.Dupes.MinSize == "1M" && c.Dupes.Limit == 20
		}},
		{[]string{"skips", "--reason", "bad_name"}, func(c cli) bool {
			return c.Skips.Reason == "bad_name" && c.Skips.Limit == 100
		}},
	} {
		t.Run(strings.Join(tt.args, " "), func(t *testing.T) {
			var root cli
			if _, err := parseCLI(&root, tt.args); err != nil {
				t.Fatal(err)
			}
			if !tt.check(root) {
				t.Fatalf("parsed %+v", root)
			}
		})
	}
}

func TestCLIRejectsMissingFlagValues(t *testing.T) {
	for _, args := range [][]string{
		{"config", "--config"},
		{"config", "--config=settings.toml", "--volume"},
		{"search", "notes", "--ext"},
		{"search", "notes", "--json", "--ext"},
		{"scan", `E:\Files`, "--config"},
		{"enrich", "123", "--task", "ocr", "--model"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			_, err := parseCLI(&cli{}, args)
			if !errors.Is(err, errMissingFlagValue) || !strings.Contains(err.Error(), args[len(args)-1]) {
				t.Fatalf("expected missing value error for %s, got %v", args[len(args)-1], err)
			}
		})
	}
}

func TestCLIRejectsInvalidSelections(t *testing.T) {
	for _, args := range [][]string{
		{"search", "words", "--kind", "folder"},
		{"enrich", "123", "--task", "caption"},
		{"enrich", "123"},
		{"scan", `E:\`, "--volume", "known", "--new-volume"},
		{"scan", `E:\`, "--no-hash", "--rebuild-content"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			if _, err := parseCLI(&cli{}, args); err == nil {
				t.Fatal("invalid selection accepted")
			}
		})
	}
}
