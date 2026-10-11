package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/config"
)

type httpProvider struct {
	key            Key
	endpoint       string
	apiKey         string
	client         *http.Client
	maxTokens      int
	tokenParameter string
}

func newHTTP(cfg config.AI, task string) (Provider, error) {
	if cfg.Model == "" {
		return nil, errors.New("a vision model is required: set --model or ai.model")
	}
	endpoint, err := url.Parse(strings.TrimRight(cfg.Endpoint, "/"))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("ai.endpoint must be an HTTP(S) base URL without credentials, query or fragment")
	}
	parameter := cfg.TokenParameter
	if parameter != "max_tokens" && parameter != "max_completion_tokens" {
		return nil, errors.New("ai.token_parameter must be max_tokens or max_completion_tokens")
	}
	apiKey := ""
	if cfg.APIKeyEnv != "" {
		apiKey = os.Getenv(cfg.APIKeyEnv)
		if apiKey == "" {
			return nil, fmt.Errorf("API key environment variable %s is unset", cfg.APIKeyEnv)
		}
	}
	base := endpoint.String()
	return &httpProvider{key: Key{Task: task, Provider: base, Model: cfg.Model, PromptVersion: fmt.Sprintf("%s-v1;%s=%d", task, parameter, cfg.MaxTokens)}, endpoint: base + "/chat/completions", apiKey: apiKey, maxTokens: cfg.MaxTokens, tokenParameter: parameter, client: &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("provider redirects are disabled") }}}, nil
}

func (p *httpProvider) Key() Key             { return p.key }
func (p *httpProvider) Extensions() []string { return Images }

func (p *httpProvider) Read(ctx context.Context, path string) (Result, error) {
	image, mime, err := imageBytes(path)
	if err != nil {
		return Result{}, err
	}
	body := map[string]any{"model": p.key.Model, "stream": false, p.tokenParameter: p.maxTokens, "messages": []any{map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "text", "text": prompt(p.key.Task)},
		map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(image)}},
	}}}}
	data, err := json.Marshal(body)
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(data))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
	response, err := p.client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Result{}, fmt.Errorf("vision provider returned HTTP %d", response.StatusCode)
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, 4<<20+1))
	if err != nil {
		return Result{}, err
	}
	if len(data) > 4<<20 {
		return Result{}, errors.New("vision response exceeds 4 MiB")
	}
	var decoded struct {
		Model   string `json:"model"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content string `json:"content"`
				Refusal string `json:"refusal"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return Result{}, fmt.Errorf("vision response: %w", err)
	}
	if len(decoded.Choices) != 1 {
		return Result{}, errors.New("vision provider returned no single answer")
	}
	answer := decoded.Choices[0]
	if answer.Message.Refusal != "" || (answer.FinishReason != "stop" && answer.FinishReason != "length") {
		return Result{}, fmt.Errorf("vision provider did not finish an answer: %s", answer.FinishReason)
	}
	result := normalized(Result{Text: answer.Message.Content, Truncated: answer.FinishReason == "length", ReportedModel: decoded.Model})
	if p.key.Task == Describe && result.Text == "" {
		return Result{}, errors.New("vision provider returned an empty description")
	}
	return result, nil
}

// A fixed upload bound also protects callers using ai.max_bytes = 0 for PDFs.
func imageBytes(path string) ([]byte, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 20<<20+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > 20<<20 {
		return nil, "", errors.New("vision image exceeds 20 MiB")
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return data, mime, nil
	default:
		return nil, "", fmt.Errorf("vision input is %s; supported images are PNG, JPEG, GIF and WebP", mime)
	}
}
