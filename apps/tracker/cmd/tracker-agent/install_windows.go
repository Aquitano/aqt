package main

import (
	"errors"
	"os"
	"os/exec"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	runKey   = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue = "TrackerAgent"
)

// install starts the agent at every sign-in from where this exe is now, and
// starts it at once; an agent already running makes the new one exit.
func install() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if err := key.SetStringValue(runValue, `"`+exe+`"`); err != nil {
		return err
	}
	if err := exec.Command(exe).Start(); err != nil {
		return err
	}
	alert("The tracker agent is running and starts at every sign-in from\n"+exe, windows.MB_ICONINFORMATION)
	return nil
}

func uninstall() error {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if err := key.DeleteValue(runValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	alert("The tracker agent no longer starts at sign-in. Quit it from its tray menu to stop it now.", windows.MB_ICONINFORMATION)
	return nil
}
