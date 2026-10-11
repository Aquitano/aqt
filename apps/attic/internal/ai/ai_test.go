package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/config"
)

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII="

func testImage(t *testing.T) string {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(pixel)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "copy.png")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHTTPVisionRequestAndProvenance(t *testing.T) {
	path := testImage(t)
	t.Setenv("ATTIC_TEST_API_KEY", "test-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body["model"] != "model-a" || body["max_completion_tokens"] != float64(123) || body["stream"] != false {
			t.Errorf("request fields: %+v", body)
		}
		messages := body["messages"].([]any)
		content := messages[0].(map[string]any)["content"].([]any)
		uri := content[1].(map[string]any)["image_url"].(map[string]any)["url"]
		if uri != "data:image/png;base64,"+pixel {
			t.Errorf("image was not supplied inline")
		}
		fmt.Fprint(w, `{"model":"model-a-resolved","choices":[{"finish_reason":"length","message":{"content":"  yellow submarine\u0000  "}}]}`)
	}))
	defer server.Close()
	cfg := config.Default().AI
	cfg.Provider = "openai"
	cfg.Model = "model-a"
	cfg.Endpoint = server.URL + "/v1/"
	cfg.APIKeyEnv = "ATTIC_TEST_API_KEY"
	cfg.MaxTokens = 123
	cfg.TokenParameter = "max_completion_tokens"
	p, err := New(t.Context(), cfg, Describe)
	if err != nil {
		t.Fatal(err)
	}
	r, err := p.Read(t.Context(), path)
	if err != nil || r.Text != "yellow submarine" || !r.Truncated || r.ReportedModel != "model-a-resolved" {
		t.Fatalf("result %+v %v", r, err)
	}
	if p.Key().Provider != server.URL+"/v1" || !strings.Contains(p.Key().PromptVersion, "123") {
		t.Fatalf("key %+v", p.Key())
	}
}

func TestHTTPVisionFailures(t *testing.T) {
	t.Setenv("ATTIC_TEST_API_KEY", "test-provider-key")
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"unauthorized", `invalid credentials: test-provider-key`, 401},
		{"invalid", "not json", 200},
		{"refusal", `{"choices":[{"finish_reason":"stop","message":{"content":"","refusal":"no"}}]}`, 200},
		{"tool call", `{"choices":[{"finish_reason":"tool_calls","message":{"content":"claim"}}]}`, 200},
		{"empty description", `{"choices":[{"finish_reason":"stop","message":{"content":""}}]}`, 200},
		{"oversize", strings.Repeat("x", 4<<20+1), 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(tc.status); fmt.Fprint(w, tc.body) }))
			defer server.Close()
			cfg := config.Default().AI
			cfg.Model = "test"
			cfg.Endpoint = server.URL
			cfg.APIKeyEnv = "ATTIC_TEST_API_KEY"
			p, err := New(t.Context(), cfg, Describe)
			if err != nil {
				t.Fatal(err)
			}
			_, err = p.Read(t.Context(), testImage(t))
			if err == nil || strings.Contains(err.Error(), "test-provider-key") {
				t.Fatalf("err %v", err)
			}
		})
	}
}

func TestHTTPDoesNotFollowRedirects(t *testing.T) {
	called := false
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	cfg := config.Default().AI
	cfg.Model = "test"
	cfg.Endpoint = source.URL
	p, err := New(t.Context(), cfg, Describe)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Read(t.Context(), testImage(t)); err == nil || called {
		t.Fatalf("redirect sent content: %v, %v", called, err)
	}
}

func TestHTTPContextCancels(t *testing.T) {
	started := make(chan struct{})
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-done }))
	defer server.Close()
	cfg := config.Default().AI
	cfg.Model = "test"
	cfg.Endpoint = server.URL
	p, err := New(t.Context(), cfg, Describe)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	go func() { <-started; cancel() }()
	_, err = p.Read(ctx, testImage(t))
	close(done)
	if err == nil {
		t.Fatal("cancelled request succeeded")
	}
}

func TestMain(m *testing.M) {
	switch os.Getenv("ATTIC_AI_HELPER") {
	case "codex":
		for _, flag := range []string{"exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "read-only", "approval_policy=\"never\""} {
			if !slices.Contains(os.Args, flag) {
				fmt.Fprintln(os.Stderr, "missing", flag)
				os.Exit(2)
			}
		}
		i := slices.Index(os.Args, "--image")
		if i < 0 || filepath.IsAbs(os.Args[i+1]) {
			os.Exit(3)
		}
		if _, err := os.ReadFile(os.Args[i+1]); err != nil {
			os.Exit(4)
		}
		input, _ := io.ReadAll(os.Stdin)
		if !strings.Contains(string(input), "Do not use tools") {
			os.Exit(5)
		}
		fmt.Fprint(os.Stderr, "diagnostic that must not be indexed")
		fmt.Print("A yellow submarine")
		os.Exit(0)
	case "ocr":
		if slices.Contains(os.Args, "--version") {
			fmt.Println("tesseract test-1")
		} else {
			fmt.Println("INVOICE 4200")
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestCodexAndOCRUseCopies(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"codex", "ocr"} {
		t.Run(kind, func(t *testing.T) {
			t.Setenv("ATTIC_AI_HELPER", kind)
			cfg := config.Default().AI
			cfg.Model = "explicit-model"
			cfg.Codex = binary
			cfg.Tesseract = binary
			cfg.PDFToPPM = binary
			task := Describe
			cfg.Provider = "codex"
			want := "A yellow submarine"
			if kind == "ocr" {
				task = OCR
				cfg.Provider = "tesseract"
				want = "INVOICE 4200"
			}
			p, err := New(t.Context(), cfg, task)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			r, err := p.Read(ctx, testImage(t))
			if err != nil || r.Text != want {
				t.Fatalf("%+v %v", r, err)
			}
		})
	}
}

// This fixture contains only INVOICE 4200, rendered from a synthetic PDF.
func TestRealTesseract(t *testing.T) {
	cfg := config.Default().AI
	cfg.Provider = "tesseract"
	for _, binary := range []string{cfg.Tesseract, cfg.PDFToPPM} {
		if _, err := exec.LookPath(binary); err != nil {
			if os.Getenv("CI") != "" {
				t.Fatal(err)
			}
			t.Skipf("local OCR tool unavailable: %v", err)
		}
	}
	p, err := New(t.Context(), cfg, OCR)
	if err != nil {
		t.Fatal(err)
	}
	r, err := p.Read(t.Context(), "testdata/invoice.png")
	if err != nil || !strings.Contains(r.Text, "INVOICE 4200") {
		t.Fatalf("real OCR: %+v %v", r, err)
	}
}
