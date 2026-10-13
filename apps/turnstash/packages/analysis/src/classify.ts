import type { TaskCategory } from "@aqt/turnstash-core";

import { isReadOnlyCommand } from "./shell.ts";

export interface ToolStep {
  readonly tool: string;
  readonly file?: string | undefined;
  readonly command?: string | undefined;
  readonly skill?: string | undefined;
}

export interface TurnInput {
  readonly userMessage: string;
  readonly steps: ReadonlyArray<ToolStep>;
  readonly skills: ReadonlyArray<string>;
}

export interface Classification {
  readonly category: TaskCategory;
  readonly skill: string | null;
  readonly retries: number;
  readonly edits: number;
}

const editTools = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "fileedittool",
  "filewritetool",
  "cursor:edit",
  "apply_patch",
  "edit_file",
  "write_file",
  "create_file",
  "create",
  "replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "str_replace",
  "insert",
  "edit_notebook",
  "code_action",
  "patch",
]);
const readTools = new Set([
  "read",
  "grep",
  "glob",
  "filereadtool",
  "greptool",
  "globtool",
  "readfile",
  "read_file",
  "view_file",
  "grep_search",
  "find",
  "list_directory",
  "list_dir",
  "search_files",
  "ls",
  "view",
  "codebase_search",
  "semantic_search",
]);
const shellTools = new Set([
  "bash",
  "bashtool",
  "powershelltool",
  "powershell",
  "shell",
  "exec",
  "exec_command",
  "shell_command",
  "run_command",
  "run_shell_command",
  "execute_command",
  "terminal",
  "run_terminal_cmd",
]);
const taskTools = new Set([
  "taskcreate",
  "taskupdate",
  "taskget",
  "tasklist",
  "taskoutput",
  "taskstop",
  "todowrite",
  "update_plan",
]);
const searchTools = new Set([
  "websearch",
  "webfetch",
  "toolsearch",
  "web_search",
  "web_fetch",
  "fetch",
  "google_web_search",
]);
const agentTools = new Set(["agent", "task", "spawn_agent", "subagent_spawn", "invoke_subagent"]);
const planTools = new Set(["enterplanmode", "exitplanmode"]);

const kind = (tool: string) => tool.toLowerCase();
const isEditTool = (tool: string): boolean => editTools.has(kind(tool));
export const isShellTool = (tool: string): boolean => shellTools.has(kind(tool));
export const isSkillTool = (tool: string): boolean => kind(tool) === "skill";
export const isMcpTool = (tool: string): boolean => tool.startsWith("mcp__");
export const isAgentTool = (tool: string): boolean => agentTools.has(kind(tool));

const testPatterns =
  /\b(test|pytest|vitest|jest|mocha|spec|coverage|npm\s+test|npx\s+vitest|npx\s+jest)\b/i;
const gitPatterns =
  /\bgit\s+(push|pull|commit|merge|rebase|checkout|branch|stash|log|diff|status|add|reset|cherry-pick|tag)\b/i;
const buildPatterns =
  /\b(npm\s+run\s+build|npm\s+publish|pip\s+install|docker|deploy|make\s+build|npm\s+run\s+dev|npm\s+start|pm2|systemctl|brew|cargo\s+build)\b/i;
const installPatterns =
  /\b(npm\s+install|pip\s+install|brew\s+install|apt\s+install|cargo\s+add)\b/i;

const debugKeywords =
  /\b(fix|bug|error|broken|failing|crash|issue|debug|traceback|exception|stack\s*trace|not\s+working|wrong|unexpected|status\s+code|404|500|401|403)\b/i;
const featureKeywords =
  /\b(add|create|implement|new|build|feature|introduce|set\s*up|scaffold|generate|make\s+(?:a|me|the)|write\s+(?:a|me|the))\b/i;
const refactorKeywords =
  /\b(refactor|clean\s*up|rename|reorganize|simplify|extract|restructure|move|migrate|split)\b/i;
const brainstormKeywords =
  /\b(brainstorm|idea|what\s+if|explore|think\s+about|approach|strategy|design|consider|how\s+should|what\s+would|opinion|suggest|recommend)\b/i;
const researchKeywords =
  /\b(research|investigate|look\s+into|find\s+out|check|search|analyze|review|understand|explain|how\s+does|what\s+is|show\s+me|list|compare)\b/i;

const filePatterns =
  /\.(py|js|ts|tsx|jsx|json|yaml|yml|toml|sql|sh|go|rs|java|rb|php|css|html|md|csv|xml)\b/i;
const scriptPatterns =
  /\b(run\s+\S+\.\w+|execute|scrip?t|curl|api\s+\S+|endpoint|request\s+url|fetch\s+\S+|query|database|db\s+\S+)\b/i;
const urlPattern = /https?:\/\/\S+/i;

// The earliest keyword match wins, so "add error handling" is a feature rather than debugging.
const firstMatch = (
  text: string,
  candidates: ReadonlyArray<readonly [RegExp, TaskCategory]>,
): TaskCategory | null => {
  let best: { readonly index: number; readonly category: TaskCategory } | null = null;
  for (const [regex, category] of candidates) {
    const match = regex.exec(text);
    if (match !== null && (best === null || match.index < best.index))
      best = { index: match.index, category };
  }
  return best?.category ?? null;
};

const byToolPattern = (input: TurnInput): TaskCategory | null => {
  const tools = input.steps.map((step) => kind(step.tool));
  if (tools.length === 0) return null;
  if (tools.some((tool) => planTools.has(tool))) return "planning";
  if (tools.some((tool) => agentTools.has(tool))) return "delegation";

  const hasEdits = tools.some((tool) => editTools.has(tool));
  const hasReads = tools.some((tool) => readTools.has(tool));
  const hasShell = tools.some((tool) => shellTools.has(tool));
  const hasTasks = tools.some((tool) => taskTools.has(tool));
  const hasSearch = tools.some((tool) => searchTools.has(tool));
  const hasMcp = tools.some((tool) => tool.startsWith("mcp__"));
  const hasSkill = tools.some((tool) => tool === "skill");

  if (hasShell && !hasEdits) {
    if (testPatterns.test(input.userMessage)) return "testing";
    if (gitPatterns.test(input.userMessage)) return "git";
    if (buildPatterns.test(input.userMessage) || installPatterns.test(input.userMessage))
      return "build/deploy";
  }
  if (hasEdits) return "coding";
  if (hasShell && hasReads) return "exploration";
  if (hasShell) return "coding";
  if (hasSearch || hasMcp) return "exploration";
  if (hasReads) return "exploration";
  if (hasTasks) return "planning";
  if (hasSkill) return "general";
  return null;
};

const refine = (category: TaskCategory, userMessage: string): TaskCategory => {
  if (category === "coding") {
    return (
      firstMatch(userMessage, [
        [refactorKeywords, "refactoring"],
        [featureKeywords, "feature"],
        [debugKeywords, "debugging"],
      ]) ?? "coding"
    );
  }
  if (category === "exploration") {
    if (researchKeywords.test(userMessage)) return "exploration";
    if (debugKeywords.test(userMessage)) return "debugging";
  }
  return category;
};

const byMessage = (userMessage: string): TaskCategory => {
  if (brainstormKeywords.test(userMessage)) return "brainstorming";
  if (researchKeywords.test(userMessage)) return "exploration";
  const debugOrFeature = firstMatch(userMessage, [
    [featureKeywords, "feature"],
    [debugKeywords, "debugging"],
  ]);
  if (debugOrFeature !== null) return debugOrFeature;
  if (filePatterns.test(userMessage) || scriptPatterns.test(userMessage)) return "coding";
  if (urlPattern.test(userMessage)) return "exploration";
  return "conversation";
};

// An edit of a file that was already edited, with a non-inspection shell command in between, is a retry.
const countRetries = (steps: ReadonlyArray<ToolStep>): number => {
  const lastEdit = new Map<string, number>();
  let lastVerify = -1;
  let retries = 0;
  steps.forEach((step, index) => {
    if (isShellTool(step.tool) && (step.command === undefined || !isReadOnlyCommand(step.command)))
      lastVerify = index;
    if (isEditTool(step.tool) && step.file !== undefined) {
      const key = step.file;
      const previous = lastEdit.get(key);
      if (previous !== undefined && lastVerify > previous && lastVerify < index) retries += 1;
      lastEdit.set(key, index);
    }
  });
  return retries;
};

export const classifyTurn = (input: TurnInput): Classification => {
  const tooled = byToolPattern(input);
  const category =
    tooled === null ? byMessage(input.userMessage) : refine(tooled, input.userMessage);
  return {
    category,
    skill: input.skills[0] ?? null,
    retries: countRetries(input.steps),
    edits: input.steps.filter((step) => isEditTool(step.tool)).length,
  };
};
