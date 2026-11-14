// Package process runs bounded, cancellable extraction subprocesses without a shell.
package process

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"time"
)

var ErrOutputLimit = errors.New("subprocess output exceeds its limit")

// Run caps stdout and truncates diagnostic stderr. Exceeding stdout kills the subprocess.
// A caller must supply a context with a deadline for tools that can hang.
func Run(ctx context.Context, binary, dir string, args []string, input io.Reader, maxOutput int) ([]byte, error) {
	resolved, err := exec.LookPath(binary)
	if err != nil {
		return nil, err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	out := limitedBuffer{left: maxOutput, cancel: cancel}
	stderr := limitedBuffer{left: 8192}
	cmd := exec.CommandContext(ctx, resolved, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, &out, &stderr
	cmd.Dir = dir
	cmd.WaitDelay = 2 * time.Second
	wait, err := startTree(cmd)
	if err == nil {
		err = wait()
	}
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

// Proc is a subprocess that stays running and talks over its standard
// streams. Its whole process tree ends with Close or with the context Start
// was given.
type Proc struct {
	Stdin  io.WriteCloser
	Stdout io.Reader
	stderr *limitedBuffer
	cancel context.CancelFunc
	wait   func() error
}

func Start(ctx context.Context, binary string, args []string) (*Proc, error) {
	resolved, err := exec.LookPath(binary)
	if err != nil {
		return nil, err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, resolved, args...)
	p := &Proc{stderr: &limitedBuffer{left: 8192}, cancel: cancel}
	cmd.Stderr = p.stderr
	cmd.WaitDelay = 2 * time.Second
	if p.Stdin, err = cmd.StdinPipe(); err != nil {
		cancel()
		return nil, err
	}
	if p.Stdout, err = cmd.StdoutPipe(); err != nil {
		cancel()
		return nil, err
	}
	if p.wait, err = startTree(cmd); err != nil {
		cancel()
		return nil, err
	}
	return p, nil
}

// Close ends the process tree. Its exit status says nothing a caller that
// chose to end it can use.
func (p *Proc) Close() {
	p.cancel()
	_ = p.wait()
}

// Stderr returns the start of what the process wrote to stderr, once Close
// has returned.
func (p *Proc) Stderr() string { return p.stderr.String() }
