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
	if _, err := folders.Load("", nil); err != nil {
		t.Fatal(err)
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
	if _, err := folders.Load("/Backups", nil); err != nil {
		t.Fatal(err)
	}
	if folders.For("/Backups/copy.zip").ArchiveDepth != 1 {
		t.Fatal("cached lookup hid a deeper override")
	}
	if scopes := folders.ArchiveScopes(); !slices.Equal(scopes, []ArchiveScope{{Path: "/", Depth: 0}, {Path: "/backups", Depth: 1}}) {
		t.Fatalf("sparse policy snapshot: %+v", scopes)
	}
	folders.Block("/Backups")
	if scopes := folders.ArchiveScopes(); !slices.Equal(scopes, []ArchiveScope{{Path: "/", Depth: 0}, {Path: "/backups", Depth: 0}}) {
		t.Fatalf("blocked policy snapshot: %+v", scopes)
	}
	if rules := folders.For("/Backups/copy.zip"); rules.ArchiveDepth != 0 || !rules.SkipContent("/Backups/copy.zip") {
		t.Fatal("unresolved policy allowed content reads")
	}
	if rules := folders.For("/Other/copy.zip"); rules.ArchiveDepth != 0 || rules.SkipContent("/Other/copy.zip") {
		t.Fatal("blocking a folder changed a sibling's policy")
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
	for _, body := range []string{"exclude = [", "temp = '/other'", "[ai]\nprovider = 'codex'", "[archives]\ndepth = -1", "[archives]\ntemp = '/other'"} {
		t.Run(body, func(t *testing.T) {
			_, err := Default().Rules("", "").WithFolder("/Backups", []byte(body))
			if err == nil || !strings.Contains(err.Error(), "/Backups/.attic.toml") {
				t.Fatalf("invalid folder config: %v", err)
			}
		})
	}
}

func TestFolderLookupFindsCaseVariantsAndRejectsDuplicates(t *testing.T) {
	root := t.TempDir()
	folders := NewFolders(root, Default().Rules("", ""))
	upper := filepath.Join(root, ".ATTIC.TOML")
	if err := os.WriteFile(upper, []byte("[archives]\ndepth = 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if rules, err := folders.Load("", nil); err != nil || rules.ArchiveDepth != 1 {
		t.Fatalf("uppercase policy: %+v, %v", rules, err)
	}
	lower := filepath.Join(root, FolderFile)
	if _, err := os.Lstat(lower); err == nil {
		return
	}
	if err := os.WriteFile(lower, []byte("[archives]\ndepth = 2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := folders.Load("", nil); err == nil || !strings.Contains(err.Error(), "multiple") {
		t.Fatalf("duplicate policies: %v", err)
	}
}
