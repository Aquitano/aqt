import { type } from "arktype";

const workspaceTasks = type({
  task_config: { includes: "string[]" },
  tasks: {
    check: { depends: "string[]" },
    "ts:check": { depends: "string[]" },
    "shared:ts": "object | string",
  },
});

export function validateMiseNamespace(content: string, name: string, taskNames: string[]): void {
  const config = workspaceTasks.assert(Bun.TOML.parse(content));
  if (!config.task_config.includes.includes("tools/tasks")) {
    throw new Error("The workspace mise.toml must include tools/tasks.");
  }
  if (
    !config.tasks.check.depends.includes("*:check") ||
    !config.tasks["ts:check"].depends.includes("*:ts")
  ) {
    throw new Error("Workspace checks must discover app tasks through *:check and *:ts.");
  }
  if (taskNames.some((task) => task === name || task.startsWith(`${name}:`))) {
    throw new Error(`Task namespace already exists: ${name}`);
  }
}

export function buildMiseTasks(name: string): string {
  return `["${name}:check"]
description = "Check ${name} and shared TypeScript packages"
depends = ["shared:ts", "${name}:ts"]

["${name}:ts"]
dir = "{{config_root}}/apps/${name}"
run = "bun run check"

["${name}:dev"]
dir = "{{config_root}}/apps/${name}"
run = "bun run dev"
`;
}
