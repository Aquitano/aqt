package main

import (
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/attic/config"
	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
)

func inspectFolder(cfg config.Config, volumeID string, mounted disk.Volume, rel []string) (config.Rules, []string, error) {
	rules := cfg.Rules(volumeID, mounted.Label)
	folders := config.NewFolders(mounted.Root, rules)
	dir := mounted.Root
	for i := 0; i <= len(rel); i++ {
		if i > 0 {
			dir = filepath.Join(dir, rel[i-1])
		}
		var err error
		rules, err = folders.Load("/"+strings.Join(rel[:i], "/"), dir, nil)
		if err != nil {
			return rules, nil, err
		}
	}
	return rules, folders.Files, nil
}
