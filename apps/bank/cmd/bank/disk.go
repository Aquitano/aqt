package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/disks/config"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// diskCmd is `bank disk`: the commands that run on the machine the disks
// attach to. They read and write the catalogue only through bank's API, at
// BANK_URL or in process, and read the disks themselves.
type diskCmd struct {
	Scan       scanCmd       `cmd:"" help:"Index a folder and its descendants."`
	Search     diskSearchCmd `cmd:"" help:"Find files on disks, with filters by volume, folder, extension and entry kind."`
	Entry      entryCmd      `cmd:"" help:"Show an entry by ID: where it is, its versions and its other copies."`
	Get        getCmd        `cmd:"" help:"Retrieve one verified file to a new destination."`
	Verify     diskVerifyCmd `cmd:"" help:"Run a maintenance check against stored file hashes."`
	Enrich     enrichCmd     `cmd:"" help:"Explicitly run OCR or image descriptions."`
	Analysis   analysisCmd   `cmd:"" help:"Compare stored OCR and descriptions by model."`
	Volumes    volumesCmd    `cmd:"" help:"List known volumes and their last scans."`
	Scans      scansCmd      `cmd:"" help:"List scan history, phase times and counts."`
	Skips      skipsCmd      `cmd:"" help:"Show what a scan left out and why."`
	Dupes      dupesCmd      `cmd:"" help:"Find contents stored more than once."`
	Redundancy redundancyCmd `cmd:"" help:"Report content on fewer than two recorded volumes."`
	Dedupe     dedupeCmd     `cmd:"" help:"Move copies outside the kept folders into a quarantine folder on their disk."`
	Organize   organizeCmd   `cmd:"" help:"Rename reviewed files and folders within one volume, with a journal and undo."`
	Config     configCmd     `cmd:"" help:"Show the configuration and effective rules."`
}

func (diskCmd) Help() string {
	return "Run these on the machine the disks attach to. They reach the catalogue through bank serve at BANK_URL, " +
		"or through the API in process from DATABASE_URL when it is unset."
}

// connector opens bank's API: the bank serve at BANK_URL, or its handler in
// this process. The closer releases what it opened.
type connector func(context.Context) (*client.Client, func(), error)

// knownVolumes is every volume the catalogue has seen, with the fingerprints
// this machine matches its mounts against.
func knownVolumes(ctx context.Context, bank *client.Client) ([]store.Volume, error) {
	summaries, err := client.Call(ctx, bank, server.ListDiskVolumes, struct{}{})
	if err != nil {
		return nil, err
	}
	vols := make([]store.Volume, len(summaries))
	for i, s := range summaries {
		vols[i] = s.Volume
	}
	return vols, nil
}

// volumeID resolves a volume label or ID typed on the command line, or
// nothing when none was typed.
func volumeID(vols []store.Volume, name string) (string, error) {
	if name == "" {
		return "", nil
	}
	v, err := store.PickVolume(vols, name)
	return v.ID, err
}

// parseTarget reads an entry ID, which is digits only, or a content ref.
func parseTarget(arg string) (int64, ref.Content, error) {
	if id, err := strconv.ParseInt(arg, 10, 64); err == nil && id > 0 {
		return id, ref.Content{}, nil
	}
	cited, err := ref.ParseContent(arg)
	if err != nil {
		return 0, cited, fmt.Errorf("not an entry ID or a content ref: %w", err)
	}
	return 0, cited, nil
}

// contentOf is the content a target names: the ref itself, or the content
// the entry holds now.
func contentOf(ctx context.Context, bank *client.Client, target string) (ref.Content, error) {
	id, cited, err := parseTarget(target)
	if err != nil || id == 0 {
		return cited, err
	}
	entry, err := client.Call(ctx, bank, server.GetDiskEntry, server.IDInput{ID: id})
	if err != nil {
		return cited, err
	}
	if entry.Ref == "" {
		return cited, fmt.Errorf("entry %d holds no hashed content", id)
	}
	return ref.ParseContent(entry.Ref)
}

// loadConfig reads --config when given, the default file otherwise, and
// returns the path it used.
func loadConfig(path string) (config.Config, string, error) {
	if path != "" {
		c, err := config.Load(path, true)
		return c, path, err
	}
	path, err := config.Path()
	if err != nil {
		return config.Config{}, "", err
	}
	c, err := config.Load(path, false)
	return c, path, err
}
