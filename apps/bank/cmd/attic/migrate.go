package main

import (
	"context"
	"fmt"
)

type migrateCmd struct{}

func (cmd *migrateCmd) Run(ctx context.Context) error {
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	current, _, err := st.SchemaVersion(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("catalogue schema at version %d\n", current)
	return nil
}
