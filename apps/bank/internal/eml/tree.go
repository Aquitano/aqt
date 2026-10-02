package eml

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func WalkMailTree(root, layout string, importFile func(string, string, MailImportContext) error, skipped func(string, string)) error {
	if layout != "eml" && layout != "thunderbird" {
		return fmt.Errorf("mail tree layout must be eml or thunderbird")
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("mail tree root must be a directory, not a symlink")
	}
	return filepath.WalkDir(root, func(filename string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if filename == root {
			return nil
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		skip := func(reason string) {
			if skipped != nil {
				skipped(relative, reason)
			}
		}
		if entry.Type()&os.ModeSymlink != 0 {
			skip("symlink")
			return nil
		}
		if entry.IsDir() {
			if layout == "thunderbird" && !strings.HasSuffix(entry.Name(), ".sbd") {
				skip("not a Thunderbird .sbd directory")
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			skip("not a regular file")
			return nil
		}
		kind, mailbox := "eml", path.Dir(relative)
		if layout == "eml" {
			if !strings.EqualFold(filepath.Ext(entry.Name()), ".eml") {
				skip("not an EML file")
				return nil
			}
		} else {
			if filepath.Ext(entry.Name()) != "" {
				skip("not an extensionless Thunderbird mailbox")
				return nil
			}
			kind = "mbox"
			parts := strings.Split(relative, "/")
			for index := 0; index < len(parts)-1; index++ {
				parts[index] = strings.TrimSuffix(parts[index], ".sbd")
			}
			mailbox = strings.Join(parts, "/")
		}
		observation := MailImportContext{Version: 1, Kind: "export", Mailbox: mailbox, RelativePath: relative}
		if err := observation.Validate(); err != nil {
			return err
		}
		return importFile(kind, filename, observation)
	})
}
