package process

import (
	"context"
	"errors"
	"fmt"
	"os"
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
