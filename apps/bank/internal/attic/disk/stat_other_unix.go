//go:build unix && !linux

package disk

import (
	"syscall"
	"time"
)

func changeTime(*syscall.Stat_t) time.Time {
	return time.Time{}
}
