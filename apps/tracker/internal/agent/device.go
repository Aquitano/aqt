package agent

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// DeviceID returns the id stored at path, creating it on the first run. Every
// row the agent sends carries it, so a later merge across machines is a UNION.
func DeviceID(path string) (uuid.UUID, error) {
	raw, err := os.ReadFile(path)
	if err == nil {
		id, err := uuid.Parse(strings.TrimSpace(string(raw)))
		if err != nil {
			return uuid.Nil, fmt.Errorf("%s: %w", path, err)
		}
		return id, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return uuid.Nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return uuid.Nil, err
	}
	return id, os.WriteFile(path, []byte(id.String()+"\n"), 0o600)
}
