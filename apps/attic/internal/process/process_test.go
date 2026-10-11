package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("ATTIC_PROCESS_HELPER"); mode != "" {
		switch mode {
		case "stderr":
			fmt.Fprint(os.Stderr, strings.Repeat("x", 20000))
			fmt.Print("result")
		case "stdout":
			fmt.Print(strings.Repeat("x", 20000))
		case "heartbeat":
			for {
				if err := os.WriteFile(os.Args[1], []byte(time.Now().String()), 0600); err != nil {
					os.Exit(3)
				}
				time.Sleep(20 * time.Millisecond)
			}
		case "spawn", "spawnexit":
			child := exec.Command(os.Args[0], os.Args[1])
			child.Env = append(os.Environ(), "ATTIC_PROCESS_HELPER=heartbeat")
			child.Stdout, child.Stderr = os.Stdout, os.Stderr
			if err := child.Start(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			fmt.Println(child.Process.Pid)
			for {
				if _, err := os.Stat(os.Args[1]); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if mode == "spawnexit" {
				os.Exit(0)
			}
			_ = child.Wait()
		case "hang":
			time.Sleep(time.Hour)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestRunBoundsOutputAndTime(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ATTIC_PROCESS_HELPER", "stderr")
	out, err := Run(context.Background(), binary, t.TempDir(), nil, nil, 1024)
	if err != nil || string(out) != "result" {
		t.Fatalf("noisy stderr: %q %v", out, err)
	}
	t.Setenv("ATTIC_PROCESS_HELPER", "stdout")
	_, err = Run(context.Background(), binary, "", nil, nil, 1024)
	if !errors.Is(err, ErrOutputLimit) {
		t.Fatalf("stdout bound: %v", err)
	}
	t.Setenv("ATTIC_PROCESS_HELPER", "hang")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = Run(ctx, binary, "", nil, nil, 1024)
	if err == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("deadline: %v", err)
	}
}

// The grandchild writes continuously. Both cancellation and an exited launcher
// must stop those writes before Run returns, on Unix and Windows alike.
func TestRunOwnsGrandchildren(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"spawn", "spawnexit"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("ATTIC_PROCESS_HELPER", mode)
			marker := filepath.Join(t.TempDir(), "heartbeat")
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if mode == "spawn" {
				go func() {
					for ctx.Err() == nil {
						if _, err := os.Stat(marker); err == nil {
							cancel()
							return
						}
						time.Sleep(10 * time.Millisecond)
					}
				}()
			}
			out, err := Run(ctx, binary, t.TempDir(), []string{marker}, nil, 1024)
			if len(out) == 0 {
				t.Fatalf("grandchild did not start: %v", err)
			}
			before, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(150 * time.Millisecond)
			after, err := os.ReadFile(marker)
			if err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) {
				t.Fatal("grandchild still running after its launcher stopped")
			}
		})
	}
}
