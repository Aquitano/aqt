package main

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

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

// parseSize reads "10M", "512kb", "2G" or a plain byte count.
func parseSize(raw string) (int64, error) {
	s := strings.TrimSuffix(strings.ToUpper(strings.TrimSpace(raw)), "B")
	mult := int64(1)
	if s != "" {
		if i := strings.IndexByte("KMGT", s[len(s)-1]); i >= 0 {
			mult = int64(1) << (10 * (i + 1))
			s = s[:len(s)-1]
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || n > math.MaxInt64/mult {
		return 0, fmt.Errorf("not a size: %q", raw)
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
