// tracker-agent is the Windows desktop agent: from the notification area it
// records which app and window has focus as spans for the tracker server, the
// counterpart of the macOS menu-bar agent in desktop/.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"gopkg.in/natefinch/lumberjack.v2"

	"github.com/aquitano/aqt/apps/tracker/internal/agent"
)

// Windows gives a window about 5 s to answer WM_ENDSESSION at sign-out, which
// is when systray runs the quit path.
const quitFlushTimeout = 2 * time.Second

func main() {
	var err error
	switch command := strings.Join(os.Args[1:], " "); command {
	case "":
		err = run()
	case "install":
		err = install()
	case "uninstall":
		err = uninstall()
	default:
		err = fmt.Errorf("unknown command %q\n\nusage: tracker-agent [install | uninstall]", command)
	}
	if err != nil {
		alert(err.Error(), windows.MB_ICONERROR)
		os.Exit(1)
	}
}

func run() error {
	if first, err := firstInstance(); err != nil || !first {
		return err
	}
	dir, err := dataDir()
	if err != nil {
		return err
	}
	log := logger(dir)
	cfg, err := agent.ConfigFromEnv(os.LookupEnv)
	if err != nil {
		return err
	}
	deviceID, err := agent.DeviceID(filepath.Join(dir, "device-id"))
	if err != nil {
		return err
	}
	outbox, aside, err := agent.OpenOutbox(filepath.Join(dir, "outbox", deviceID.String()+".jsonl"))
	if err != nil {
		return err
	}
	if aside != "" {
		log.Warn("outbox was unreadable, moved it aside and started a new one", "path", aside)
	}

	changed := make(chan struct{}, 1)
	notify := func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
	syncer, err := agent.NewSyncer(cfg, deviceID, outbox, log, notify)
	if err != nil {
		return err
	}
	tracking, stopTracking := context.WithCancel(context.Background())
	defer stopTracking()
	signals := make(chan agent.Signal, 16)
	if err := watch(signals, tracking.Done(), log); err != nil {
		return err
	}
	tracker := agent.New(newDesktop(), cfg.Lists, syncer, log, notify)
	commands := make(chan agent.Command)
	tracked := background(func() { tracker.Run(tracking, signals, commands) })
	syncing, stopSyncing := context.WithCancel(context.Background())
	synced := background(func() { syncer.Run(syncing) })

	shutdown := sync.OnceFunc(func() {
		stopTracking()
		<-tracked
		stopSyncing()
		<-synced
		ctx, cancel := context.WithTimeout(context.Background(), quitFlushTimeout)
		defer cancel()
		syncer.Flush(ctx)
		log.Info("stopped", "pending", syncer.Status().Pending)
	})
	log.Info("started", "device_id", deviceID, "server", cfg.ServerURL, "token", cfg.TokenPath)
	systray.Run(func() { runTray(tracker, syncer, commands, changed) }, shutdown)
	// Quit from the menu runs shutdown on the tray's goroutine while systray's
	// loop winds down on its own; this call waits for that run to finish.
	shutdown()
	return nil
}

func background(f func()) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	return done
}

// firstInstance holds a named mutex for the life of the process. A second
// agent, from a double-click or a second Run entry, would count every span
// twice, so it exits quietly instead.
func firstInstance() (bool, error) {
	name, err := windows.UTF16PtrFromString(`Local\tracker-agent`)
	if err != nil {
		return false, err
	}
	_, err = windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return false, nil
	}
	return err == nil, err
}

func dataDir() (string, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return "", errors.New("LOCALAPPDATA is not set")
	}
	dir := filepath.Join(local, "tracker")
	return dir, os.MkdirAll(dir, 0o700)
}

// logger also takes over the standard logger, which is where systray reports
// its errors.
func logger(dir string) *slog.Logger {
	var level slog.Level
	if err := level.UnmarshalText([]byte(os.Getenv("TRACKER_LOG_LEVEL"))); err != nil {
		level = slog.LevelInfo
	}
	file := &lumberjack.Logger{Filename: filepath.Join(dir, "agent.log"), MaxSize: 1, MaxBackups: 1}
	log := slog.New(slog.NewTextHandler(file, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)
	return log
}

// alert is the only way to say anything: a windowsgui binary has no console.
func alert(text string, icon uint32) {
	body, _ := windows.UTF16PtrFromString(text)
	title, _ := windows.UTF16PtrFromString("tracker agent")
	_, _ = windows.MessageBox(0, body, title, windows.MB_OK|icon)
}
