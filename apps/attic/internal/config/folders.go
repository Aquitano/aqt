package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/pelletier/go-toml/v2"
)

const FolderFile = ".attic.toml"

type Folders struct {
	Files []string
	root  string
	base  Rules
	rules map[string]Rules
	last  string
	cache Rules
}

func NewFolders(root string, base Rules) *Folders {
	return &Folders{root: root, base: base, rules: map[string]Rules{}}
}

func (f *Folders) For(file string) Rules {
	if len(f.rules) == 0 {
		return f.base
	}
	folder := path.Dir(file)
	if f.last == folder {
		return f.cache
	}
	rules := f.base
	for dir := folder; dir != "."; dir = path.Dir(dir) {
		if found, ok := f.rules[dir]; ok {
			rules = found
			break
		}
		if dir == "/" {
			break
		}
	}
	f.last, f.cache = folder, rules
	return rules
}

func (f *Folders) Block(folder string) {
	rules := f.For(folder)
	rules.unavailable, rules.ArchiveDepth = true, 0
	f.set(folder, rules)
}

func (f *Folders) set(folder string, rules Rules) {
	f.rules[path.Clean("/"+folder)] = rules
	f.last = ""
}

func (f *Folders) Load(folder string, entries []disk.Entry) (Rules, error) {
	rules := f.For(folder)
	rel := filepath.FromSlash(strings.TrimPrefix(folder, "/"))
	dir := filepath.Join(f.root, rel)
	if entries == nil {
		info, err := disk.Stat(dir)
		if err != nil {
			return rules, err
		}
		if !info.Dir || info.Link || info.Remote {
			return rules, fmt.Errorf("%s is not an ordinary local folder", dir)
		}
		entries, err = disk.LookupFold(dir, FolderFile)
		if err != nil {
			return rules, err
		}
	}
	name := ""
	for _, entry := range entries {
		if strings.EqualFold(entry.Name, FolderFile) {
			if name != "" {
				return rules, fmt.Errorf("%s has multiple folder configuration files", dir)
			}
			name = entry.Name
		}
	}
	if name == "" {
		return rules, nil
	}
	file, err := disk.OpenOrdinary(f.root, filepath.Join(rel, name))
	if err != nil {
		return rules, err
	}
	const limit = 64 << 10
	data, readErr := io.ReadAll(io.LimitReader(file, limit+1))
	if err := errors.Join(readErr, file.Close()); err != nil {
		return rules, fmt.Errorf("%s: %w", file.Name(), err)
	}
	if len(data) > limit {
		return rules, fmt.Errorf("%s exceeds the 64 KiB folder configuration limit", file.Name())
	}
	rules, err = rules.WithFolder(folder, data)
	if err != nil {
		return rules, err
	}
	f.set(folder, rules)
	f.Files = append(f.Files, filepath.Join(dir, name))
	return rules, nil
}

type ArchiveScope struct {
	Path  string
	Depth int
}

type ArchiveRange struct {
	Lower string
	Upper string
	Depth int
}

// ArchiveRanges partitions sparse folder policies into disjoint byte-order
// ranges. Disabled scopes cut holes that deeper policies can reopen.
func ArchiveRanges(scopes []ArchiveScope) []ArchiveRange {
	type boundary struct {
		path  string
		depth int
		end   bool
	}
	boundaries := make([]boundary, 0, 2*len(scopes))
	for _, scope := range scopes {
		prefix := strings.TrimRight(scope.Path, "/")
		boundaries = append(boundaries, boundary{path: prefix + "/", depth: scope.Depth}, boundary{path: prefix + "0", end: true})
	}
	slices.SortFunc(boundaries, func(a, b boundary) int { return strings.Compare(a.path, b.path) })
	var ranges []ArchiveRange
	var depths []int
	previous := ""
	for _, b := range boundaries {
		if len(depths) > 0 && depths[len(depths)-1] > 0 && previous < b.path {
			depth := depths[len(depths)-1]
			if len(ranges) > 0 && ranges[len(ranges)-1].Upper == previous && ranges[len(ranges)-1].Depth == depth {
				ranges[len(ranges)-1].Upper = b.path
			} else {
				ranges = append(ranges, ArchiveRange{Lower: previous, Upper: b.path, Depth: depth})
			}
		}
		if b.end {
			depths = depths[:len(depths)-1]
		} else {
			depths = append(depths, b.depth)
		}
		previous = b.path
	}
	return ranges
}

func (f *Folders) ArchiveScopes() []ArchiveScope {
	scopes := make([]ArchiveScope, 0, len(f.rules)+1)
	if _, ok := f.rules["/"]; !ok {
		scopes = append(scopes, ArchiveScope{Path: "/", Depth: f.base.ArchiveDepth})
	}
	for folder, rules := range f.rules {
		scopes = append(scopes, ArchiveScope{Path: folder, Depth: rules.ArchiveDepth})
	}
	slices.SortFunc(scopes, func(a, b ArchiveScope) int { return strings.Compare(a.Path, b.Path) })
	return scopes
}

func (r Rules) WithFolder(folder string, data []byte) (Rules, error) {
	var local struct {
		Exclude  []string `toml:"exclude"`
		NameOnly []string `toml:"name_only"`
		Archives struct {
			Depth *int `toml:"depth"`
		} `toml:"archives"`
	}
	source := strings.TrimRight(folder, "/") + "/" + FolderFile
	dec := toml.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&local); err != nil {
		return r, fmt.Errorf("%s: %w", source, err)
	}
	if local.Archives.Depth != nil {
		if *local.Archives.Depth < 0 {
			return r, fmt.Errorf("%s: archives.depth must not be negative", source)
		}
		r.ArchiveDepth = *local.Archives.Depth
	}
	var domain []string
	if folder = strings.Trim(folder, "/"); folder != "" {
		domain = strings.Split(strings.ToLower(folder), "/")
	}
	r.exclude = compile(slices.Clip(r.exclude), local.Exclude, source, domain...)
	r.nameOnly = compile(slices.Clip(r.nameOnly), local.NameOnly, source, domain...)
	return r, nil
}
