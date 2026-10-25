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
	Temp         string   `toml:"temp,omitempty"`
	Archives     Archives `toml:"archives"`
	Text         Text     `toml:"text"`
	Metadata     Metadata `toml:"metadata"`
	AI           AI       `toml:"ai"`
	Volumes      []Volume `toml:"volume"`
}

// Archives says how far a scan reads into archives.
type Archives struct {
	// Depth counts the archive levels opened, the one on disk included; 0
	// leaves archives unread.
	Depth int `toml:"depth"`
	// UnpackMaxBytes caps a nested archive copied to the shared temp directory; 0
	// copies any size.
	UnpackMaxBytes int64 `toml:"unpack_max_bytes"`
	// Temp accepts the legacy archives.temp alias for Config.Temp.
	Temp string `toml:"temp,omitempty"`
}

// Text says which documents a scan reads for their words.
type Text struct {
	// MaxBytes leaves larger documents unread; 0 reads any size.
	MaxBytes int64 `toml:"max_bytes"`
}

// Metadata controls batch extraction on temporary copies.
type Metadata struct {
	Enabled  bool   `toml:"enabled"`
	ExifTool string `toml:"exiftool"`
	MaxBytes int64  `toml:"max_bytes"`
	Temp     string `toml:"temp,omitempty"`
}

// AI is used only by the explicit enrich command, never by scan.
type AI struct {
	Provider       string `toml:"provider"`
	Endpoint       string `toml:"endpoint"`
	Model          string `toml:"model"`
	APIKeyEnv      string `toml:"api_key_env"`
	MaxBytes       int64  `toml:"max_bytes"`
	Temp           string `toml:"temp,omitempty"`
	TimeoutSeconds int    `toml:"timeout_seconds"`
	MaxTokens      int    `toml:"max_tokens"`
	TokenParameter string `toml:"token_parameter"`
	OCRLang        string `toml:"ocr_lang"`
	OCRMaxPages    int    `toml:"ocr_max_pages"`
	Tesseract      string `toml:"tesseract"`
	PDFToPPM       string `toml:"pdftoppm"`
	Codex          string `toml:"codex"`
}

// Default is the configuration before the file is read: archives inside
// archives are listed, nested ones up to 4 GiB, and documents up to 64 MiB
// are read.
func Default() Config {
	return Config{Archives: Archives{Depth: 2, UnpackMaxBytes: 4 << 30}, Text: Text{MaxBytes: 64 << 20}, Metadata: Metadata{Enabled: true, ExifTool: "exiftool", MaxBytes: 1 << 30}, AI: AI{Endpoint: "http://localhost:11434/v1", MaxBytes: 64 << 20, TimeoutSeconds: 300, MaxTokens: 4096, TokenParameter: "max_tokens", OCRLang: "eng", OCRMaxPages: 20, Tesseract: "tesseract", PDFToPPM: "pdftoppm", Codex: "codex"}}
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
// output, installed game libraries, the folders and files Windows owns, and
// the quarantine dedupe moves extra copies into. AppData stays in: profile
// backups keep game saves, mail and browser profiles there. A pattern with a
// slash inside is anchored at the volume root, hence the leading **/ on
// .yarn/cache.
var DefaultExclude = []string{
	"node_modules/", ".git/", ".pnpm-store/", "**/.yarn/cache/", "vendor/", ".venv/", "venv/", "__pycache__/",
	"target/", "dist/", "build/", ".gradle/", ".next/", ".nuxt/", ".turbo/", ".cache/",
	"steamapps/", "SteamLibrary/", "Epic Games/", "Riot Games/", "Battle.net/", "XboxGames/", "GOG Games/",
	"/Windows/", "/Program Files/", "/Program Files (x86)/", "/ProgramData/",
	"$Recycle.Bin/", "System Volume Information/", "/Recovery/",
	"/pagefile.sys", "/hiberfil.sys", "/swapfile.sys", "/DumpStack.log.tmp",
	"/.attic-quarantine/",
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
	var paths struct {
		Temp     *string `toml:"temp"`
		Archives struct {
			Temp *string `toml:"temp"`
		} `toml:"archives"`
		Metadata struct {
			Temp *string `toml:"temp"`
		} `toml:"metadata"`
		AI struct {
			Temp *string `toml:"temp"`
		} `toml:"ai"`
	}
	if err := toml.Unmarshal(data, &paths); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	if err := c.resolveTemp(paths.Temp, paths.Archives.Temp, paths.Metadata.Temp, paths.AI.Temp); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	if err := c.Validate(); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

func (c Config) Validate() error {
	return errors.Join(c.ValidateScan(), c.AI.Validate())
}

func (c Config) ValidateScan() error {
	if c.HashMaxBytes < 0 || c.Archives.Depth < 0 || c.Archives.UnpackMaxBytes < 0 || c.Text.MaxBytes < 0 || c.Metadata.MaxBytes < 0 {
		return errors.New("hash_max_bytes, archives.depth, archives.unpack_max_bytes, text.max_bytes and metadata.max_bytes must not be negative")
	}
	return nil
}

func (a AI) Validate() error {
	if a.MaxBytes < 0 || a.TimeoutSeconds <= 0 || a.MaxTokens <= 0 || a.OCRMaxPages <= 0 {
		return errors.New("ai limits must be positive; max_bytes may be zero")
	}
	return nil
}

func (c *Config) NormalizeTemp() error {
	nonempty := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	return c.resolveTemp(nonempty(c.Temp), nonempty(c.Archives.Temp), nonempty(c.Metadata.Temp), nonempty(c.AI.Temp))
}

func (c *Config) resolveTemp(paths ...*string) error {
	names := []string{"temp", "archives.temp", "metadata.temp", "ai.temp"}
	clean := func(s string) string {
		if s == "" {
			s = os.TempDir()
		}
		return filepath.Clean(s)
	}
	var selected *string
	var source string
	for i, p := range paths {
		if p == nil || i >= 2 && *p == "" {
			continue
		}
		if selected != nil && clean(*p) != clean(*selected) {
			return fmt.Errorf("conflicting temporary directories in %s and %s; use one shared temp setting", source, names[i])
		}
		selected, source = p, names[i]
	}
	if selected != nil {
		c.Temp = *selected
	}
	c.Archives.Temp, c.Metadata.Temp, c.AI.Temp = "", "", ""
	return nil
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

// SkipContent applies read exclusions to a catalogued path, including parent
// directories that a fresh walk would not enter.
func (r Rules) SkipContent(path string) bool {
	parts := strings.Split(strings.ToLower(strings.TrimPrefix(path, "/")), "/")
	if excluded, _ := r.Excluded(parts, false); excluded || r.NameOnly(parts) {
		return true
	}
	for i := 1; i < len(parts); i++ {
		if excluded, _ := r.Excluded(parts[:i], true); excluded {
			return true
		}
	}
	return false
}
