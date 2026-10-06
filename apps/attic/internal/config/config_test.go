package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func split(p string) []string { return strings.Split(strings.ToLower(p), "/") }

func TestRules(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.toml")
	err := os.WriteFile(file, []byte(`
exclude = ["*.iso"]

[[volume]]
label = "Data"
exclude = ["/Games/", "!node_modules/"]
`), 0o600)
	if err != nil {
		t.Fatal(err)
	}
	c, err := Load(file, true)
	if err != nil {
		t.Fatal(err)
	}
	data := c.Rules("", "DATA")
	other := c.Rules("", "Stick")

	cases := []struct {
		rules    Rules
		path     string
		dir      bool
		excluded bool
	}{
		{other, "Projects/web/node_modules", true, true},
		{other, "Projects/web/.yarn/cache", true, true},
		{other, "Backup/Users/thomas/AppData", true, false},
		{other, "$RECYCLE.BIN", true, true},
		{other, "Backups/disk.ISO", false, true},
		{other, "Games", true, false},
		{other, "Old/Windows", true, false},
		{other, "Windows", true, true},
		{data, "Games", true, true},
		{data, "Files/Games", true, false},
		{data, "Projects/web/node_modules", true, false},
	}
	for _, tc := range cases {
		got, rule := tc.rules.Excluded(split(tc.path), tc.dir)
		if got != tc.excluded {
			t.Errorf("Excluded(%q) = %v (%s), want %v", tc.path, got, rule, tc.excluded)
		}
	}
	if !other.NameOnly(split("BitLocker Recovery Key D501E19A.TXT")) {
		t.Error("recovery key file should be name-only")
	}
}

func TestLoadMissing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "none.toml")
	if _, err := Load(missing, false); err != nil {
		t.Errorf("default path missing: %v", err)
	}
	if _, err := Load(missing, true); err == nil {
		t.Error("explicit path missing: want an error")
	}
}

// Setting one archive key must not reset the others to "no limit".
func TestArchiveKeysKeepTheirDefaults(t *testing.T) {
	file := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(file, []byte("[archives]\ndepth = 3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(file, true)
	if err != nil || c.Archives.Depth != 3 || c.Archives.UnpackMaxBytes != Default().Archives.UnpackMaxBytes {
		t.Errorf("archives %+v, %v: want depth 3 and the default unpack cap", c.Archives, err)
	}
}
