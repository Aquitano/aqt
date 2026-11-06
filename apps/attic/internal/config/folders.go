package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
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
	for dir := strings.ToLower(folder); dir != "."; dir = path.Dir(dir) {
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
	f.rules[path.Clean("/"+strings.ToLower(folder))] = rules
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
		entries, err = folderFiles(dir)
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

func folderFiles(dir string) ([]disk.Entry, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var entries []disk.Entry
	for {
		names, err := f.Readdirnames(128)
		for _, name := range names {
			if strings.EqualFold(name, FolderFile) {
				entries = append(entries, disk.Entry{Name: name})
			}
		}
		if errors.Is(err, io.EOF) {
			return entries, nil
		}
		if err != nil {
			return nil, err
		}
	}
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
