package ai

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/process"
)

type codex struct {
	key    Key
	binary string
}

func (p *codex) Key() Key             { return p.key }
func (p *codex) Extensions() []string { return Images }
func (p *codex) Read(ctx context.Context, path string) (Result, error) {
	if _, _, err := imageBytes(path); err != nil {
		return Result{}, err
	}
	args := []string{"exec", "--model", p.key.Model, "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only", "-c", "approval_policy=\"never\"", "-c", "shell_environment_policy.inherit=\"none\"", "--color", "never", "--image", filepath.Base(path), "-"}
	out, err := process.Run(ctx, p.binary, filepath.Dir(path), args, strings.NewReader(prompt(p.key.Task)), 4<<20)
	if err != nil {
		return Result{}, err
	}
	result := normalized(Result{Text: string(out), ReportedModel: p.key.Model})
	if p.key.Task == Describe && result.Text == "" {
		return Result{}, errors.New("Codex returned an empty description")
	}
	return result, nil
}
