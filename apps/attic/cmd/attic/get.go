package main

import (
	"context"
	"fmt"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/retrieve"
)

type getCmd struct {
	Target string `arg:"" name:"id-or-ref" help:"Hashed ordinary-file entry ID or content ref; no archive members or directories."`
	To     string `required:"" name:"to" help:"New destination file in an existing directory; never overwritten. On Windows use a different volume from the source."`
	Config string `help:"Configuration file for content rules. Retrieval stages beside the destination, independent of temp."`
	JSON   bool   `help:"Print the verified digest, destination and source as JSON."`
}

func (cmd *getCmd) Run(ctx context.Context) error {
	id, ref, err := parseTarget(cmd.Target)
	if err != nil {
		return err
	}
	cfg, _, err := loadConfig(cmd.Config)
	if err != nil {
		return err
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	content, err := st.Retrieval(ctx, id, ref)
	if err != nil {
		return err
	}
	vols, err := st.KnownVolumes(ctx)
	if err != nil {
		return err
	}
	result, err := retrieve.Get(ctx, content, cmd.To, vols, disk.Mounted(), cfg)
	if err != nil {
		return err
	}
	if cmd.JSON {
		return printJSON(result)
	}
	fmt.Printf("%s saved to %s (%d bytes, BLAKE3 verified)\n", result.Ref, result.Destination, result.Size)
	return nil
}
