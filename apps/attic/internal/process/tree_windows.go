package process

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Start suspended so a launcher cannot spawn children before joining the job.
// Closing the job also stops children whose launcher has already exited.
func runTree(cmd *exec.Cmd) error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	cmd.Cancel = func() error {
		// Cancellation can race with job assignment; kill the suspended process
		// directly as well, so it cannot be resumed outside the cancelled job.
		return errors.Join(windows.TerminateJobObject(job, 1), cmd.Process.Kill())
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := joinAndResume(job, uint32(cmd.Process.Pid)); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	return cmd.Wait()
}

func joinAndResume(job windows.Handle, pid uint32) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		return err
	}
	// os/exec closes CreateProcess's thread handle. The suspended process has
	// only its primary thread; recover that handle through the system snapshot.
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{}
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err := windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		defer windows.CloseHandle(thread)
		_, err = windows.ResumeThread(thread)
		return err
	}
	return fmt.Errorf("primary thread for suspended process %d not found", pid)
}
