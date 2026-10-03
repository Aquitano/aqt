import { execFileSync } from "node:child_process";
import process from "node:process";

const changes = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", "dist"],
  {
    cwd: import.meta.dirname,
    encoding: "utf8",
  },
);

if (changes.trim()) {
  console.error("Embedded UI assets differ from Git. Commit the rebuilt dist/ with its source.");
  console.error(changes);
  process.exitCode = 1;
}
