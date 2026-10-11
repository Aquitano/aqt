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

// Run caps stdout and truncates diagnostic stderr. Exceeding stdout kills the subprocess.
// A caller must supply a context with a deadline for tools that can hang.
func Run(ctx context.Context, binary, dir string, args []string, input io.Reader, maxOutput int) ([]byte, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := limitedBuffer{left: maxOutput, cancel: cancel}
	stderr := limitedBuffer{left: 8192}
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, &out, &stderr
	cmd.Dir = dir
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if out.exceeded {
		return nil, ErrOutputLimit
	}
	if err != nil {
		return out.Bytes(), fmt.Errorf("%s: %w: %s", binary, err, stderr.String())
	}
	return out.Bytes(), nil
}

type limitedBuffer struct {
	buf      bytes.Buffer
	left     int
	exceeded bool
	cancel   context.CancelFunc
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.cancel == nil {
		n := len(p)
		_, _ = b.buf.Write(p[:min(len(p), b.left)])
		b.left -= min(len(p), b.left)
		return n, nil
	}
	if len(p) > b.left {
		b.exceeded = true
		b.cancel()
		return 0, ErrOutputLimit
	}
	b.left -= len(p)
	return b.buf.Write(p)
}

func (b *limitedBuffer) Bytes() []byte  { return b.buf.Bytes() }
func (b *limitedBuffer) String() string { return b.buf.String() }
