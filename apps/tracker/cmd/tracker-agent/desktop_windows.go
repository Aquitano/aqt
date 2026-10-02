package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/aquitano/aqt/apps/tracker/internal/agent"
)

var (
	user32               = windows.NewLazySystemDLL("user32.dll")
	procGetWindowText    = user32.NewProc("GetWindowTextW")
	procGetLastInputInfo = user32.NewProc("GetLastInputInfo")
	procFindWindowEx     = user32.NewProc("FindWindowExW")
)

// desktop answers the agent's questions about the foreground window. Only the
// agent's goroutine calls it, so the app cache needs no lock.
type desktop struct {
	self uint32
	apps map[string]agent.App
}

func newDesktop() *desktop {
	return &desktop{self: windows.GetCurrentProcessId(), apps: map[string]agent.App{}}
}

// Foreground skips the agent's own windows: opening the tray menu brings one
// to the front.
func (d *desktop) Foreground() (agent.Window, bool) {
	hwnd := windows.GetForegroundWindow()
	if hwnd == 0 {
		return agent.Window{}, false
	}
	class := className(hwnd)
	pid := processOf(hwnd)
	// A store app's frame belongs to ApplicationFrameHost.exe; the app owns the
	// core window inside it.
	if class == "ApplicationFrameWindow" {
		if core := childOfClass(hwnd, "Windows.UI.Core.CoreWindow"); core != 0 {
			pid = processOf(core)
		}
	}
	if pid == 0 || pid == d.self {
		return agent.Window{}, false
	}
	app, ok := d.app(pid)
	if !ok {
		return agent.Window{}, false
	}
	return agent.Window{App: app, Class: class, Title: windowText(hwnd)}, true
}

func (d *desktop) LastInput() time.Time {
	now := time.Now()
	info := struct{ size, tick uint32 }{size: 8}
	if ok, _, _ := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(&info))); ok == 0 {
		return now
	}
	// Both are 32-bit millisecond tick counts, which wrap every 49.7 days;
	// subtracting them as uint32 survives the wrap.
	tick := uint32(windows.DurationSinceBoot().Milliseconds())
	return now.Add(-time.Duration(tick-info.tick) * time.Millisecond)
}

func (d *desktop) app(pid uint32) (agent.App, bool) {
	path, err := imagePath(pid)
	if err != nil {
		return agent.App{}, false
	}
	if app, ok := d.apps[path]; ok {
		return app, true
	}
	base := filepath.Base(path)
	name := fileDescription(path)
	if name == "" {
		name = strings.TrimSuffix(base, filepath.Ext(base))
	}
	app := agent.App{Name: name, ID: strings.ToLower(base)}
	d.apps[path] = app
	return app, true
}

func imagePath(pid uint32) (string, error) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(process)
	var buf [1024]uint16
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(process, 0, &buf[0], &size); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf[:size]), nil
}

// fileDescription is the name an exe gives itself in its version resource,
// "Visual Studio Code" for Code.exe, in the first language it lists or else
// US English.
func fileDescription(path string) string {
	size, err := windows.GetFileVersionInfoSize(path, nil)
	if err != nil || size == 0 {
		return ""
	}
	info := make([]byte, size)
	block := unsafe.Pointer(&info[0])
	if err := windows.GetFileVersionInfo(path, 0, size, block); err != nil {
		return ""
	}
	languages := []string{"040904b0"}
	var translation *[2]uint16
	var n uint32
	if windows.VerQueryValue(block, `\VarFileInfo\Translation`, unsafe.Pointer(&translation), &n) == nil && n >= 4 {
		languages = append([]string{fmt.Sprintf("%04x%04x", translation[0], translation[1])}, languages...)
	}
	for _, language := range languages {
		var text *uint16
		if windows.VerQueryValue(block, `\StringFileInfo\`+language+`\FileDescription`, unsafe.Pointer(&text), &n) != nil || n == 0 {
			continue
		}
		if name := strings.TrimFunc(windows.UTF16PtrToString(text), invisible); name != "" {
			return name
		}
	}
	return ""
}

// invisible also covers format characters such as a directionality mark,
// which no category rule anchored at ^ would ever match.
func invisible(r rune) bool {
	return unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}

// windowText reads the caption of another process's top-level window from
// the window manager without sending it a message, so a hung app cannot hang
// the agent.
func windowText(hwnd windows.HWND) string {
	var buf [1024]uint16
	n, _, _ := procGetWindowText.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

func className(hwnd windows.HWND) string {
	var buf [256]uint16
	n, err := windows.GetClassName(hwnd, &buf[0], int32(len(buf)))
	if err != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

func processOf(hwnd windows.HWND) uint32 {
	var pid uint32
	if _, err := windows.GetWindowThreadProcessId(hwnd, &pid); err != nil {
		return 0
	}
	return pid
}

func childOfClass(parent windows.HWND, class string) windows.HWND {
	name, err := windows.UTF16PtrFromString(class)
	if err != nil {
		return 0
	}
	child, _, _ := procFindWindowEx.Call(uintptr(parent), 0, uintptr(unsafe.Pointer(name)), 0)
	return windows.HWND(child)
}
