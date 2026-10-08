package archive

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListDoesNotCreateMissingTempBase(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "missing", "scratch")
	_, err := List(context.Background(), "archive.zip", os.Open, Options{Depth: 2, Temp: base},
		func(Member) error { return nil }, func(Skip) {})
	if err == nil {
		t.Fatal("listing with a missing temporary base succeeded")
	}
	if _, err := os.Stat(filepath.Join(root, "missing")); !os.IsNotExist(err) {
		t.Fatalf("listing created an unchecked temporary base: %v", err)
	}
}

func TestListContinuesWhenCleanupLockCannotOpen(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "aqt-attic", ".cleanup.lock"), 0o700); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	data := zipOf(t, map[string][]byte{"inner.zip": zipOf(t, map[string][]byte{"note.txt": []byte("hello")})})
	res, members, _ := list(t, data, Options{Depth: 2, Temp: base, Log: slog.New(slog.NewTextHandler(&logs, nil))})
	if res.Status != Listed || len(members) != 2 {
		t.Fatalf("listing after cleanup failure: %+v, members %+v", res, members)
	}
	if !strings.Contains(logs.String(), "level=WARN") || !strings.Contains(logs.String(), ".cleanup.lock") {
		t.Fatalf("cleanup failure was not logged: %s", logs.String())
	}
}

func TestListContinuesAfterStaleCleanupFailureAndRetries(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "aqt-attic")
	blocked := filepath.Join(root, "scan-1")
	removable := filepath.Join(root, "scan-2")
	for _, dir := range []string{blocked, removable} {
		if err := os.MkdirAll(filepath.Join(dir, "nested"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".lock"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "nested", "copy.zip"), []byte("copy"), 0o600); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-48 * time.Hour)
		if err := os.Chtimes(dir, old, old); err != nil {
			t.Fatal(err)
		}
	}
	unblock := preventRemoval(t, filepath.Join(blocked, "nested", "copy.zip"))
	var logs bytes.Buffer
	data := zipOf(t, map[string][]byte{"inner.zip": zipOf(t, map[string][]byte{"note.txt": []byte("hello")})})
	res, members, _ := list(t, data, Options{Depth: 2, Temp: base, Log: slog.New(slog.NewTextHandler(&logs, nil))})
	if res.Status != Listed || len(members) != 2 {
		t.Fatalf("listing after cleanup failure: %+v, members %+v", res, members)
	}
	if !strings.Contains(logs.String(), "level=WARN") || !strings.Contains(logs.String(), "scan-1") {
		t.Fatalf("cleanup failure was not logged: %s", logs.String())
	}
	if _, err := os.Stat(filepath.Join(blocked, ".lock")); err != nil {
		t.Fatalf("failed cleanup lost its marker: %v", err)
	}
	if _, err := os.Stat(removable); !os.IsNotExist(err) {
		t.Fatalf("one failed cleanup prevented another: %v", err)
	}
	unblock()
	list(t, data, Options{Depth: 2, Temp: base})
	if _, err := os.Stat(blocked); !os.IsNotExist(err) {
		t.Fatalf("later listing did not retry cleanup: %v", err)
	}
}

func TestListReportsWorkspaceCleanupFailure(t *testing.T) {
	for _, name := range []string{"listed", "emit failed"} {
		t.Run(name, func(t *testing.T) {
			base := t.TempDir()
			p := filepath.Join(t.TempDir(), "archive.zip")
			if err := os.WriteFile(p, zipOf(t, map[string][]byte{"note.txt": []byte("hello")}), 0o600); err != nil {
				t.Fatal(err)
			}
			var emitErr error
			if name == "emit failed" {
				emitErr = errors.New("emit failed")
			}
			var blocked string
			_, err := List(context.Background(), p, os.Open, Options{Depth: 2, Temp: base}, func(Member) error {
				workspaces, err := filepath.Glob(filepath.Join(base, "aqt-attic", "scan-*"))
				if err != nil || len(workspaces) != 1 {
					t.Fatalf("active workspaces %v: %v", workspaces, err)
				}
				dir := filepath.Join(workspaces[0], "nested")
				if err := os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				blocked = filepath.Join(dir, "copy.zip")
				if err := os.WriteFile(blocked, []byte("copy"), 0o600); err != nil {
					t.Fatal(err)
				}
				preventRemoval(t, blocked)
				return emitErr
			}, func(Skip) {})
			var pathErr *os.PathError
			if !errors.As(err, &pathErr) || pathErr.Path != blocked {
				t.Errorf("listing did not return the cleanup failure for %s: %v", blocked, err)
			}
			if emitErr != nil && !errors.Is(err, emitErr) {
				t.Errorf("cleanup lost the listing error: %v", err)
			}
		})
	}
}
