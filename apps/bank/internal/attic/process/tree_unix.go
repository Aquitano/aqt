//go:build !windows

package process

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// A private process group keeps launcher children inside the same lifetime.
func startTree(cmd *exec.Cmd) (wait func() error, err error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	kill := func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.Cancel = kill
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return func() error {
		defer func() { _ = kill() }()
		return cmd.Wait()
	}, nil
}
