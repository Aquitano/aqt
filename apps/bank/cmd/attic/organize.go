package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/attic/organize"
)

type organizeCmd struct {
	Prepare organizePrepareCmd `cmd:"" help:"Check a move list and save a plan with what each move covers. Moves nothing."`
	Apply   organizeApplyCmd   `cmd:"" help:"Run a prepared plan: rename, verify and journal each move. Run it again to resume."`
	Undo    organizeUndoCmd    `cmd:"" help:"Move a plan's applied moves back when they are unchanged."`
}

type organizePrepareCmd struct {
	Moves string `arg:"" help:"JSON move list: a root folder and moves with from, to and an optional reason."`
	Out   string `help:"Where to save the plan. Defaults to the move list's name ending in .plan.json."`
	JSON  bool   `help:"Print JSON."`
}

type preparedMove struct {
	organize.Action
	Reason  string `json:"reason,omitempty"`
	Files   int    `json:"files"`
	Folders int    `json:"folders"`
	Bytes   int64  `json:"bytes"`
}

func (cmd *organizePrepareCmd) Run(ctx context.Context) error {
	p, err := organize.Read(cmd.Moves)
	if err != nil {
		return err
	}
	vol, err := organize.Mount(p.Root)
	if err != nil {
		return err
	}
	out := cmd.Out
	if out == "" {
		out = strings.TrimSuffix(cmd.Moves, ".json") + ".plan.json"
	}
	actions, err := organize.Prepare(ctx, &p, vol, out)
	if err != nil {
		return err
	}
	ready := !actions.Blocked()
	moves := make([]preparedMove, len(actions))
	for i, a := range actions {
		files, folders, bytes := p.Moves[i].Totals()
		moves[i] = preparedMove{Action: a, Reason: p.Moves[i].Reason, Files: files, Folders: folders, Bytes: bytes}
	}
	var blocked error
	if !ready {
		blocked, out = errors.New("some moves cannot run, so no plan was saved"), ""
	}
	newFolders := organize.NewFolders(p)
	if cmd.JSON {
		return errors.Join(blocked, printJSON(struct {
			Plan       string         `json:"plan,omitempty"`
			Root       string         `json:"root"`
			Moves      []preparedMove `json:"moves"`
			NewFolders []string       `json:"new_folders"`
		}{out, p.Root, moves, newFolders}))
	}
	var files, folders, size int64
	for _, m := range moves {
		if m.Status == organize.Blocked {
			fmt.Printf("blocked  %s -> %s: %s\n", m.From, m.To, m.Problem)
			continue
		}
		fmt.Printf("ready    %s -> %s  (%s, %s, %s)\n", m.From, m.To, plural(int64(m.Files), "file"), plural(int64(m.Folders), "folder"), humanBytes(m.Bytes))
		files, folders, size = files+int64(m.Files), folders+int64(m.Folders), size+m.Bytes
	}
	for _, dir := range newFolders {
		fmt.Printf("new      %s/\n", dir)
	}
	if ready {
		fmt.Printf("\n%s of %s and %s, %s, in %s. Saved %s; review it, then run `attic organize apply %s`.\n",
			plural(int64(len(moves)), "move"), plural(files, "file"), plural(folders, "folder"), humanBytes(size), p.Root, out, out)
	}
	return blocked
}

type organizeApplyCmd struct {
	Plan string `arg:"" help:"Prepared plan file."`
	JSON bool   `help:"Print JSON."`
}

func (cmd *organizeApplyCmd) Run(ctx context.Context) error {
	run, err := organize.Open(cmd.Plan)
	if err != nil {
		return err
	}
	defer run.Close()
	res, err := run.Apply(ctx)
	return printOrganize(res, err, cmd.JSON, fmt.Sprintf("Undo with `attic organize undo %s`. Scan %s so the catalogue follows the moves.", cmd.Plan, res.Root))
}

type organizeUndoCmd struct {
	Plan string `arg:"" help:"Plan file that apply ran."`
	JSON bool   `help:"Print JSON."`
}

func (cmd *organizeUndoCmd) Run(ctx context.Context) error {
	run, err := organize.Open(cmd.Plan)
	if err != nil {
		return err
	}
	defer run.Close()
	res, err := run.Undo(ctx)
	return printOrganize(res, err, cmd.JSON, fmt.Sprintf("Scan %s so the catalogue follows the moves.", res.Root))
}

func printOrganize(res organize.Result, err error, asJSON bool, next string) error {
	if res.Actions == nil {
		return err
	}
	if err == nil && res.Actions.Blocked() {
		err = errors.New("some moves are blocked; see their problems")
	}
	if asJSON {
		return errors.Join(err, printJSON(res))
	}
	counts := map[organize.Status]int64{}
	for _, a := range res.Actions {
		counts[a.Status]++
		line := fmt.Sprintf("%-13s %s -> %s", a.Status, a.From, a.To)
		if a.Problem != "" {
			line += ": " + a.Problem
		}
		fmt.Println(line)
	}
	var parts []string
	for _, s := range []organize.Status{organize.Moved, organize.AlreadyMoved, organize.Restored, organize.NotMoved, organize.Pending, organize.Blocked} {
		if counts[s] > 0 {
			parts = append(parts, fmt.Sprintf("%s %s", count(counts[s]), strings.ReplaceAll(string(s), "_", " ")))
		}
	}
	fmt.Printf("\n%s. Every moved, already moved and restored object matched its baseline where it is now. Journal: %s. %s\n", strings.Join(parts, ", "), res.Journal, next)
	return err
}
