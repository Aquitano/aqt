// Package config reads attic's one configuration file and turns its patterns
// into the rules a scan applies to a volume.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	// Exclude and NameOnly apply to every volume, after the defaults.
	Exclude  []string `toml:"exclude"`
	NameOnly []string `toml:"name_only"`
	// HashMaxBytes leaves larger files unhashed; 0 hashes every file.
	HashMaxBytes int64    `toml:"hash_max_bytes"`
	Archives     Archives `toml:"archives"`
	Text         Text     `toml:"text"`
	Volumes      []Volume `toml:"volume"`
}

// Archives says how far a scan reads into archives.
type Archives struct {
	// Depth counts the archive levels opened, the one on disk included; 0
	// leaves archives unread.
	Depth int `toml:"depth"`
	// UnpackMaxBytes caps a nested archive copied to Temp to be listed; 0
	// copies any size.
	UnpackMaxBytes int64 `toml:"unpack_max_bytes"`
	// Temp holds nested archives while they are listed; empty means the
	// system's temporary folder. It must not be on a disk being scanned.
	Temp string `toml:"temp"`
}

// Text says which documents a scan reads for their words.
type Text struct {
	// MaxBytes leaves larger documents unread; 0 reads any size.
	MaxBytes int64 `toml:"max_bytes"`
}

// Default is the configuration before the file is read: archives inside
// archives are listed, nested ones up to 4 GiB, and documents up to 64 MiB
// are read.
func Default() Config {
	return Config{Archives: Archives{Depth: 2, UnpackMaxBytes: 4 << 30}, Text: Text{MaxBytes: 64 << 20}}
}

// Volume holds patterns anchored at one volume's root, selected by attic's
// volume id or by label.
type Volume struct {
	ID       string   `toml:"id"`
	Label    string   `toml:"label"`
	Exclude  []string `toml:"exclude"`
	NameOnly []string `toml:"name_only"`
}

// DefaultExclude keeps out what no search wants: dependency trees and build
// output, installed game libraries, and the folders and files Windows owns.
// AppData stays in: profile backups keep game saves, mail and browser
// profiles there. A pattern with a slash inside is anchored at the volume
// root, hence the leading **/ on .yarn/cache.
var DefaultExclude = []string{
	"node_modules/", ".git/", ".pnpm-store/", "**/.yarn/cache/", "vendor/", ".venv/", "venv/", "__pycache__/",
	"target/", "dist/", "build/", ".gradle/", ".next/", ".nuxt/", ".turbo/", ".cache/",
	"steamapps/", "SteamLibrary/", "Epic Games/", "Riot Games/", "Battle.net/", "XboxGames/", "GOG Games/",
	"/Windows/", "/Program Files/", "/Program Files (x86)/", "/ProgramData/",
	"$Recycle.Bin/", "System Volume Information/", "/Recovery/",
	"/pagefile.sys", "/hiberfil.sys", "/swapfile.sys", "/DumpStack.log.tmp",
}

// DefaultNameOnly lists files indexed by name and never read: BitLocker
// writes recovery keys as plain text next to the data they unlock.
var DefaultNameOnly = []string{"*Recovery Key*.txt"}

// Path is where the configuration lives when --config is not given.
func Path() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "attic", "config.toml"), nil
}

// Load reads path over the defaults. A missing file at the default path is
// the default configuration; a missing file someone named explicitly is an
// error.
func Load(path string, explicit bool) (Config, error) {
	c := Default()
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) && !explicit {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	dec := toml.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	if c.HashMaxBytes < 0 || c.Archives.Depth < 0 || c.Archives.UnpackMaxBytes < 0 || c.Text.MaxBytes < 0 {
		return c, fmt.Errorf("%s: hash_max_bytes, archives.depth, archives.unpack_max_bytes and text.max_bytes must not be negative", path)
	}
	return c, nil
}

// Rules are the patterns that apply to one volume, compiled once per scan.
type Rules struct {
	exclude      []rule
	nameOnly     []rule
	HashMaxBytes int64
}

type rule struct {
	source  string
	pattern gitignore.Pattern
}

// Rules compiles the defaults, the global patterns and any [[volume]] block
// matching id or label, in that order, so a later "!pattern" re-includes.
// Patterns and paths are compared lower-cased: Windows file systems ignore
// case, and "$RECYCLE.BIN" and "$Recycle.Bin" are the same folder.
func (c Config) Rules(volumeID, label string) Rules {
	r := Rules{HashMaxBytes: c.HashMaxBytes}
	r.exclude = compile(r.exclude, DefaultExclude, "default")
	r.exclude = compile(r.exclude, c.Exclude, "config")
	r.nameOnly = compile(r.nameOnly, DefaultNameOnly, "default")
	r.nameOnly = compile(r.nameOnly, c.NameOnly, "config")
	for _, v := range c.Volumes {
		// Labels ignore case: Windows stores FAT32 labels in upper case.
		if (v.ID != "" && strings.EqualFold(v.ID, volumeID)) || (v.Label != "" && strings.EqualFold(v.Label, label)) {
			r.exclude = compile(r.exclude, v.Exclude, "volume "+v.selector())
			r.nameOnly = compile(r.nameOnly, v.NameOnly, "volume "+v.selector())
		}
	}
	return r
}

func (v Volume) selector() string {
	if v.ID != "" {
		return v.ID
	}
	return v.Label
}

func compile(into []rule, patterns []string, origin string) []rule {
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" || strings.HasPrefix(p, "#") {
			continue
		}
		into = append(into, rule{source: origin + ": " + p, pattern: gitignore.ParsePattern(strings.ToLower(p), nil)})
	}
	return into
}

// Excluded reports whether the entry at path (lower-cased components from the
// volume root) is left out, and which pattern decided it.
func (r Rules) Excluded(path []string, dir bool) (bool, string) {
	return decide(r.exclude, path, dir)
}

// NameOnly reports whether a file is indexed by name and never read.
func (r Rules) NameOnly(path []string) bool {
	only, _ := decide(r.nameOnly, path, false)
	return only
}

// decide applies gitignore precedence: the last pattern that matches wins.
func decide(rules []rule, path []string, dir bool) (bool, string) {
	for i := len(rules) - 1; i >= 0; i-- {
		switch rules[i].pattern.Match(path, dir) {
		case gitignore.Exclude:
			return true, rules[i].source
		case gitignore.Include:
			return false, ""
		case gitignore.NoMatch:
		}
	}
	return false, ""
}

// Describe lists the effective rules, for `attic config`.
func (r Rules) Describe() (exclude, nameOnly []string) {
	for _, x := range r.exclude {
		exclude = append(exclude, x.source)
	}
	for _, x := range r.nameOnly {
		nameOnly = append(nameOnly, x.source)
	}
	return exclude, nameOnly
}
