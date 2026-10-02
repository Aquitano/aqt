package main

import (
	"fmt"
	"log/slog"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/aquitano/aqt/apps/tracker/internal/agent"
)

var (
	procSetWinEventHook  = user32.NewProc("SetWinEventHook")
	procUnhookWinEvent   = user32.NewProc("UnhookWinEvent")
	procGetMessage       = user32.NewProc("GetMessageW")
	procDispatchMessage  = user32.NewProc("DispatchMessageW")
	procRegisterClassEx  = user32.NewProc("RegisterClassExW")
	procCreateWindowEx   = user32.NewProc("CreateWindowExW")
	procDefWindowProc    = user32.NewProc("DefWindowProcW")
	procRegisterSessions = windows.NewLazySystemDLL("wtsapi32.dll").NewProc("WTSRegisterSessionNotification")
)

const (
	eventSystemForeground  = 0x0003
	eventObjectNameChange  = 0x800C
	winEventOutOfContext   = 0x0000
	winEventSkipOwnProcess = 0x0002
	objidWindow            = 0
	childidSelf            = 0

	wmPowerBroadcast      = 0x0218
	wmWTSSessionChange    = 0x02B1
	pbtAPMSuspend         = 0x0004
	pbtAPMResumeSuspend   = 0x0007
	pbtAPMResumeAutomatic = 0x0012
	wtsSessionLock        = 0x7
	wtsSessionUnlock      = 0x8
	notifyForThisSession  = 0
)

type msg struct {
	hwnd    windows.HWND
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      struct{ x, y int32 }
}

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   windows.Handle
	icon       windows.Handle
	cursor     windows.Handle
	background windows.Handle
	menuName   *uint16
	className  *uint16
	iconSm     windows.Handle
}

// watcher turns Win32 notifications into agent signals. Out-of-context
// WinEvents and window messages both arrive on the thread that registered
// for them, and only while it pumps messages, so all of it lives on one
// locked OS thread.
type watcher struct {
	signals  chan<- agent.Signal
	stopped  <-chan struct{}
	callback uintptr
	titles   uintptr
	titlePID uint32
}

// watch starts the watcher's thread and returns once it is listening. Once
// stopped closes, signals go nowhere: a thread blocked on a send would not
// answer the WM_ENDSESSION that sign-out sends every top-level window.
func watch(signals chan<- agent.Signal, stopped <-chan struct{}, log *slog.Logger) error {
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		w := &watcher{signals: signals, stopped: stopped}
		if err := w.listen(log); err != nil {
			ready <- err
			return
		}
		ready <- nil
		w.pump(log)
	}()
	return <-ready
}

func (w *watcher) listen(log *slog.Logger) error {
	w.callback = windows.NewCallback(w.onWinEvent)
	hook, _, err := procSetWinEventHook.Call(eventSystemForeground, eventSystemForeground, 0, w.callback,
		0, 0, winEventOutOfContext|winEventSkipOwnProcess)
	if hook == 0 {
		return fmt.Errorf("SetWinEventHook: %w", err)
	}
	w.follow(windows.GetForegroundWindow())
	hwnd, err := sessionWindow(windows.NewCallback(w.onMessage))
	if err != nil {
		return err
	}
	// Fails while Terminal Services is still starting, which a Run key at
	// sign-in can hit. A locked screen then shows up as idle input instead.
	if ok, _, err := procRegisterSessions.Call(uintptr(hwnd), notifyForThisSession); ok == 0 {
		log.Warn("no lock notifications", "err", err)
	}
	return nil
}

// follow moves the title hook to the process in front. Name changes hooked
// system-wide would wake the agent for every control renamed in every app.
func (w *watcher) follow(hwnd windows.HWND) {
	pid := processOf(hwnd)
	if pid == w.titlePID {
		return
	}
	if w.titles != 0 {
		procUnhookWinEvent.Call(w.titles)
		w.titles = 0
	}
	w.titlePID = pid
	if pid != 0 {
		w.titles, _, _ = procSetWinEventHook.Call(eventObjectNameChange, eventObjectNameChange, 0, w.callback,
			uintptr(pid), 0, winEventOutOfContext|winEventSkipOwnProcess)
	}
}

// onWinEvent takes every argument as uintptr and narrows the 32-bit ones: the
// x64 convention leaves the upper half of their registers undefined.
func (w *watcher) onWinEvent(_, event, hwnd, object, child, _, _ uintptr) uintptr {
	switch {
	case uint32(event) == eventSystemForeground:
		w.follow(windows.HWND(hwnd))
		w.send(agent.FocusChanged)
	case int32(object) == objidWindow && int32(child) == childidSelf && windows.HWND(hwnd) == windows.GetForegroundWindow():
		w.send(agent.TitleChanged)
	}
	return 0
}

func (w *watcher) onMessage(hwnd, message, wParam, lParam uintptr) uintptr {
	switch uint32(message) {
	case wmWTSSessionChange:
		switch uint32(wParam) {
		case wtsSessionLock:
			w.send(agent.Locked)
		case wtsSessionUnlock:
			w.send(agent.Unlocked)
		}
	case wmPowerBroadcast:
		switch uint32(wParam) {
		case pbtAPMSuspend:
			w.send(agent.Suspended)
		case pbtAPMResumeSuspend, pbtAPMResumeAutomatic:
			w.send(agent.Resumed)
		}
		return 1
	}
	result, _, _ := procDefWindowProc.Call(hwnd, message, wParam, lParam)
	return result
}

func (w *watcher) send(s agent.Signal) {
	select {
	case w.signals <- s:
	case <-w.stopped:
	}
}

func (w *watcher) pump(log *slog.Logger) {
	var m msg
	for {
		result, _, err := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(result) <= 0 {
			log.Error("message loop ended, focus is no longer tracked", "err", err)
			return
		}
		procDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}

// sessionWindow is hidden but top-level, not message-only: message-only
// windows get no broadcasts, and WM_POWERBROADCAST is one.
func sessionWindow(proc uintptr) (windows.HWND, error) {
	var instance windows.Handle
	if err := windows.GetModuleHandleEx(0, nil, &instance); err != nil {
		return 0, fmt.Errorf("GetModuleHandleEx: %w", err)
	}
	name, err := windows.UTF16PtrFromString("TrackerAgentSession")
	if err != nil {
		return 0, err
	}
	class := wndClassEx{wndProc: proc, instance: instance, className: name}
	class.size = uint32(unsafe.Sizeof(class))
	if atom, _, err := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return 0, fmt.Errorf("RegisterClassEx: %w", err)
	}
	hwnd, _, err := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(name)), 0, 0, 0, 0, 0, 0, 0, 0, uintptr(instance), 0)
	if hwnd == 0 {
		return 0, fmt.Errorf("CreateWindowEx: %w", err)
	}
	return windows.HWND(hwnd), nil
}
