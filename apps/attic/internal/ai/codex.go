package ai

import (
	"context"
	"errors"
	"fmt"
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
	args := []string{"exec", "--model", p.key.Model, "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--strict-config", "--color", "never"}
	for _, setting := range codexConfig {
		args = append(args, "-c", setting)
	}
	args = append(args, "--image", filepath.Base(path), "-")
	out, err := process.Run(ctx, p.binary, filepath.Dir(path), args, strings.NewReader(prompt(p.key.Task)), 4<<20)
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		return Result{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	result := normalized(Result{Text: string(out)})
	if p.key.Task == Describe && result.Text == "" {
		return Result{}, errors.New("Codex returned an empty description")
	}
	return result, nil
}

// The image is attached by exec, so the agent needs no filesystem or external
// tools. Keep a restricted command profile as well, with no host-wide read grant.
var codexConfig = []string{
	`approval_policy="never"`,
	`default_permissions="attic-image"`,
	`permissions.attic-image.filesystem={":minimal"="read",":workspace_roots"="read"}`,
	`permissions.attic-image.network.enabled=false`,
	`shell_environment_policy.inherit="none"`,
	`project_doc_max_bytes=0`,
	`web_search="disabled"`,
	`features.shell_tool=false`,
	`features.view_image=false`,
	`features.multi_agent=false`,
	`features.apps=false`,
	`features.plugins=false`,
	`features.browser_use=false`,
	`features.computer_use=false`,
	`features.hooks=false`,
	`features.skill_search=false`,
	`features.skip_host_skill_discovery=true`,
}
