package config

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestFolderLookupRefreshesCachedRulesAndBlocksUnresolvedPolicies(t *testing.T) {
	root := t.TempDir()
	folders := NewFolders(root, Default().Rules("", ""))
	if err := os.WriteFile(filepath.Join(root, FolderFile), []byte("[archives]\ndepth = 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := folders.Load("", root, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := folders.Load("/outside", t.TempDir(), nil); err == nil {
		t.Fatal("folder lookup escaped the volume root")
	}
	if folders.For("/Backups/copy.zip").ArchiveDepth != 0 {
		t.Fatal("root policy not inherited")
	}
	if err := os.Mkdir(filepath.Join(root, "Backups"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Backups", FolderFile), []byte("[archives]\ndepth = 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := folders.Load("/Backups", filepath.Join(root, "Backups"), nil); err != nil {
		t.Fatal(err)
	}
	if folders.For("/Backups/copy.zip").ArchiveDepth != 1 {
		t.Fatal("cached lookup hid a deeper override")
	}
	if scopes := folders.ArchiveScopes(); !slices.Equal(scopes, []ArchiveScope{{Path: "/", Depth: 0}, {Path: "/Backups", Depth: 1}}) {
		t.Fatalf("sparse policy snapshot: %+v", scopes)
	}
	folders.Block("/Backups")
	if scopes := folders.ArchiveScopes(); !slices.Equal(scopes, []ArchiveScope{{Path: "/", Depth: 0}, {Path: "/Backups", Depth: 0}}) {
		t.Fatalf("blocked policy snapshot: %+v", scopes)
	}
	if rules := folders.For("/Backups/copy.zip"); rules.ArchiveDepth != 0 || !rules.SkipContent("/Backups/copy.zip") {
		t.Fatal("unresolved policy allowed content reads")
	}
	if rules := folders.For("/Other/copy.zip"); rules.ArchiveDepth != 0 || rules.SkipContent("/Other/copy.zip") {
		t.Fatal("blocking a folder changed a sibling's policy")
	}
}

func TestArchiveRangesSplitNestedOverridesAndCaseSensitiveScopes(t *testing.T) {
	ranges := ArchiveRanges([]ArchiveScope{
		{Path: "/foo/open", Depth: 3},
		{Path: "/", Depth: 2},
		{Path: "/foo", Depth: 0},
		{Path: "/a", Depth: 1},
		{Path: "/A", Depth: 0},
	})
	want := []ArchiveRange{
		{Lower: "/", Upper: "/A/", Depth: 2},
		{Lower: "/A0", Upper: "/a/", Depth: 2},
		{Lower: "/a/", Upper: "/a0", Depth: 1},
		{Lower: "/a0", Upper: "/foo/", Depth: 2},
		{Lower: "/foo/open/", Upper: "/foo/open0", Depth: 3},
		{Lower: "/foo0", Upper: "0", Depth: 2},
	}
	if !slices.Equal(ranges, want) {
		t.Fatalf("disjoint archive ranges: %+v, want %+v", ranges, want)
	}
}

func TestFolderRulesInheritWithoutChangingOtherFolders(t *testing.T) {
	base := Default().Rules("", "Data")
	parent, err := base.WithFolder("/Backups", []byte("exclude = ['/Cache/']\nname_only = ['*.key']\n[archives]\ndepth = 0\n"))
	if err != nil {
		t.Fatal(err)
	}
	child, err := parent.WithFolder("/Backups/Selected", []byte("name_only = ['!public.key']\n[archives]\ndepth = 1\n"))
	if err != nil {
		t.Fatal(err)
	}
	sibling, err := parent.WithFolder("/Backups/Other", []byte("name_only = ['*.txt']\n"))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path string
		want bool
	}{
		{"backups/cache", true},
		{"backups/selected/cache", false},
		{"other/cache", false},
	} {
		if got, _ := child.Excluded(split(tc.path), true); got != tc.want {
			t.Errorf("Excluded(%q) = %t, want %t", tc.path, got, tc.want)
		}
	}
	if !parent.NameOnly(split("backups/selected/public.key")) || child.NameOnly(split("BACKUPS/Selected/public.key")) ||
		child.NameOnly(split("backups/selected/notes.txt")) || !sibling.NameOnly(split("backups/other/notes.txt")) {
		t.Fatal("child rules changed an inherited or sibling policy")
	}
	if base.ArchiveDepth != 2 || parent.ArchiveDepth != 0 || child.ArchiveDepth != 1 || sibling.ArchiveDepth != 0 {
		t.Fatalf("archive depths: %d, %d, %d, %d", base.ArchiveDepth, parent.ArchiveDepth, child.ArchiveDepth, sibling.ArchiveDepth)
	}
}

func TestFolderConfigRejectsInvalidOrMachineSettings(t *testing.T) {
	for _, body := range []string{
		"exclude = [", "temp = '/other'", "[ai]\nprovider = 'codex'", "[archives]\ndepth = -1", "[archives]\ntemp = '/other'",
		"exclude = ['secret[*.txt']", "name_only = ['secret[*.txt']", "name_only = ['prefix*[bad']", "exclude = ['dir/[a-']",
		"name_only = ['private**/secret.txt']", "exclude = ['/cache**/']",
	} {
		t.Run(body, func(t *testing.T) {
			_, err := Default().Rules("", "").WithFolder("/Backups", []byte(body))
			if err == nil || !strings.Contains(err.Error(), "/Backups/.attic.toml") {
				t.Fatalf("invalid folder config: %v", err)
			}
		})
	}
}

func TestFolderRulesAcceptGitignoreGlobsAndComments(t *testing.T) {
	rules, err := Default().Rules("", "").WithFolder("/Backups", []byte(`
exclude = ['cache**/']
name_only = ['**/secret[0-9].key', '!**/secret0.key', 'literal[[]name', '# ignored [', '']
`))
	if err != nil {
		t.Fatal(err)
	}
	if !rules.NameOnly(split("backups/child/secret1.key")) || rules.NameOnly(split("backups/child/secret0.key")) ||
		!rules.NameOnly(split("backups/literal[name")) {
		t.Fatal("valid folder patterns changed their matching behavior")
	}
	if excluded, _ := rules.Excluded(split("backups/cache-folder"), true); !excluded {
		t.Fatal("valid simple-name directory glob was rejected")
	}
}

func TestFolderLookupFindsCaseVariantsAndRejectsDuplicates(t *testing.T) {
	root := t.TempDir()
	folders := NewFolders(root, Default().Rules("", ""))
	upper := filepath.Join(root, ".ATTIC.TOML")
	if err := os.WriteFile(upper, []byte("[archives]\ndepth = 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if rules, err := folders.Load("", root, nil); err != nil || rules.ArchiveDepth != 1 {
		t.Fatalf("uppercase policy: %+v, %v", rules, err)
	}
	lower := filepath.Join(root, FolderFile)
	if _, err := os.Lstat(lower); err == nil {
		return
	}
	if err := os.WriteFile(lower, []byte("[archives]\ndepth = 2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := folders.Load("", root, nil); err == nil || !strings.Contains(err.Error(), "multiple") {
		t.Fatalf("duplicate policies: %v", err)
	}
}
