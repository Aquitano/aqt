// Package process runs bounded, cancellable extraction subprocesses without a shell.
package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
)

var ErrOutputLimit = errors.New("subprocess output exceeds its limit")

// Run caps stdout and stderr, and kills the subprocess if either limit is hit.
// A caller must supply a context with a deadline for tools that can hang.
func Run(ctx context.Context, binary string, args []string, input io.Reader, maxOutput int) ([]byte, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := limitedBuffer{left: maxOutput, cancel: cancel}
	stderr := limitedBuffer{left: 8192, cancel: cancel}
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, &out, &stderr
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if out.exceeded || stderr.exceeded {
		return nil, ErrOutputLimit
	}
	if err != nil {
		return out.Bytes(), fmt.Errorf("%s: %w: %s", binary, err, stderr.String())
	}
	return out.Bytes(), nil
}

type limitedBuffer struct {
	bytes.Buffer
	left     int
	exceeded bool
	cancel   context.CancelFunc
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.left {
		b.exceeded = true
		b.cancel()
		return 0, ErrOutputLimit
	}
	b.left -= len(p)
	return b.Buffer.Write(p)
}
