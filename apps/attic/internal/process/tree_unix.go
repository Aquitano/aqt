//go:build !windows

package process

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// A private process group keeps launcher children inside the same lifetime.
func runTree(cmd *exec.Cmd) error {
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
		return err
	}
	defer func() { _ = kill() }()
	return cmd.Wait()
}
