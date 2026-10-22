package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
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

func TestSharedTempMigratesAliasesAndRejectsConflicts(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
		conflict         bool
	}{
		{"shared", "temp = '/scratch'", "/scratch", false},
		{"archives", "[archives]\ntemp = '/scratch'", "/scratch", false},
		{"metadata", "[metadata]\ntemp = '/scratch'", "/scratch", false},
		{"ai", "[ai]\ntemp = '/scratch'", "/scratch", false},
		{"matching", "temp = '/scratch'\n[archives]\ntemp = '/scratch/.'\n[ai]\ntemp = '/scratch'", "/scratch", false},
		{"legacy conflict", "[archives]\ntemp = '/first'\n[metadata]\ntemp = '/second'", "", true},
		{"shared conflict", "temp = '/first'\n[ai]\ntemp = '/second'", "", true},
		{"explicit default conflict", "temp = ''\n[archives]\ntemp = '/scratch'", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "config.toml")
			if err := os.WriteFile(file, []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			c, err := Load(file, true)
			if tc.conflict {
				if err == nil || !strings.Contains(err.Error(), "conflicting temporary directories") {
					t.Fatalf("conflict: %v", err)
				}
				return
			}
			if err != nil || filepath.Clean(c.Temp) != tc.want || c.Archives.Temp != "" || c.Metadata.Temp != "" || c.AI.Temp != "" {
				t.Fatalf("shared temp: %+v, %v", c, err)
			}
			encoded, err := toml.Marshal(c)
			if err != nil || strings.Count(string(encoded), "temp =") != 1 {
				t.Fatalf("normalized config retains aliases: %s, %v", encoded, err)
			}
		})
	}
}

func TestProgrammaticValidation(t *testing.T) {
	c := Default()
	c.AI.MaxBytes = -1
	if c.AI.Validate() == nil || c.Validate() == nil {
		t.Fatal("negative AI byte limit accepted")
	}
	c = Default()
	c.Archives.Depth = -1
	if c.ValidateScan() == nil || c.Validate() == nil {
		t.Fatal("negative archive depth accepted")
	}
	c = Default()
	c.Metadata.Temp = "/scratch"
	if err := c.NormalizeTemp(); err != nil || c.Temp != "/scratch" || c.Metadata.Temp != "" {
		t.Fatalf("programmatic legacy temp: %+v, %v", c, err)
	}
	c.AI.Temp = "/other"
	if err := c.NormalizeTemp(); err == nil {
		t.Fatal("programmatic temp conflict accepted")
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
