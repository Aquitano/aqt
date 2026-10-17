package store

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations is the schema history Open applies, one numbered file per step.
var Migrations, _ = fs.Sub(migrationFiles, "migrations")

// Keep the legacy lock so an older command cannot migrate concurrently.
const migrationLock int64 = 0x61747469636d6967
