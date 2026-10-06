package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

// onlineRoots maps each known volume that is attached right now to where it
// is mounted, matched by file system and serial.
func onlineRoots(vols []store.Volume) map[string]string {
	roots := map[string]string{}
	for _, m := range disk.Mounted() {
		for _, v := range vols {
			if v.FS == m.FS && v.Serial == m.Serial {
				roots[v.ID] = m.Root
			}
		}
	}
	return roots
}

// displayPath spells an entry the way it can be opened right now, or names
// its volume when the disk is not attached.
func displayPath(volumeID, label, p string, roots map[string]string) string {
	rel := filepath.FromSlash(strings.TrimPrefix(p, "/"))
	if root, ok := roots[volumeID]; ok {
		return filepath.Join(root, rel)
	}
	if label == "" && len(volumeID) >= 8 {
		label = volumeID[:8]
	}
	return label + ":" + string(filepath.Separator) + rel
}

// humanBytes uses binary units, as Explorer does, so sizes match what
// Windows shows for the same files.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 4; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTP"[exp])
}

func count(n int64) string {
	s := strconv.FormatInt(n, 10)
	if n < 0 {
		return "-" + count(-n)
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// parseSize reads "10M", "512K", "2G" or a plain byte count.
func parseSize(s string) (int64, error) {
	s = strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(s), "B"))
	mult := int64(1)
	if s != "" {
		if i := strings.IndexByte("KMGT", s[len(s)-1]); i >= 0 {
			mult = int64(1) << (10 * (i + 1))
			s = s[:len(s)-1]
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("not a size: %q", s)
	}
	return n * mult, nil
}

func shortDate(t *time.Time) string {
	if t == nil {
		return "-"
	}
	return t.Local().Format("2006-01-02")
}

func stamp(t *time.Time) string {
	if t == nil {
		return "-"
	}
	return t.Local().Format("2006-01-02 15:04")
}

// stderrIsTerminal decides between redrawing one progress line and printing
// an occasional one for logs and agents.
func stderrIsTerminal() bool {
	fi, err := os.Stderr.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
