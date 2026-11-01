package main

import (
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

func inspectFolder(cfg config.Config, volumeID string, mounted disk.Volume, rel []string) (config.Rules, []string, error) {
	rules := cfg.Rules(volumeID, mounted.Label)
	folders := config.NewFolders(mounted.Root, rules)
	for i := 0; i <= len(rel); i++ {
		var err error
		rules, err = folders.Load("/"+strings.Join(rel[:i], "/"), nil)
		if err != nil {
			return rules, nil, err
		}
	}
	return rules, folders.Files, nil
}
