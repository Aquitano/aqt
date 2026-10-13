import { Schema } from "effect";

export const TaskCategory = Schema.Literals([
  "coding",
  "debugging",
  "feature",
  "refactoring",
  "testing",
  "exploration",
  "planning",
  "delegation",
  "git",
  "build/deploy",
  "conversation",
  "brainstorming",
  "general",
]);
export type TaskCategory = typeof TaskCategory.Type;
