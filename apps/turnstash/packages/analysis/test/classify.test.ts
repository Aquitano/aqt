import { expect, test } from "bun:test";

import { classifyTurn, type ToolStep } from "../src/classify.ts";
import { commandNames, isReadOnlyCommand } from "../src/shell.ts";

const edit = (file = "a.ts"): ToolStep => ({ tool: "Edit", file });
const bash = (command?: string): ToolStep => ({ tool: "Bash", command });

test("feature verbs beat debugging words that appear later, refactoring beats both", () => {
  const coding = (userMessage: string) =>
    classifyTurn({ userMessage, steps: [edit()], skills: [] }).category;
  expect(coding("add error handling to the auth module")).toBe("feature");
  expect(coding("implement the 404 page with a friendly redirect")).toBe("feature");
  expect(coding("fix the layout for the new feature")).toBe("debugging");
  expect(coding("refactor the error handling so it is cleaner")).toBe("refactoring");
  expect(
    classifyTurn({
      userMessage: "add a setting page; we will fix the styles after",
      steps: [],
      skills: [],
    }).category,
  ).toBe("feature");
  expect(
    classifyTurn({
      userMessage: "fix the bug introduced when we added the new flag",
      steps: [],
      skills: [],
    }).category,
  ).toBe("debugging");
});

test("tool shapes decide the category across provider spellings", () => {
  const of = (steps: ReadonlyArray<ToolStep>, userMessage = "") =>
    classifyTurn({ userMessage, steps, skills: [] }).category;
  expect(of([{ tool: "apply_patch" }], "please")).toBe("coding");
  expect(
    of(
      [{ tool: "exec_command", command: "bun test" }, { tool: "read_file" }],
      "the build fails with an error",
    ),
  ).toBe("debugging");
  expect(of([{ tool: "shell", command: "npm test" }], "run the test suite")).toBe("testing");
  expect(of([{ tool: "spawn_agent" }, edit()])).toBe("delegation");
  expect(of([{ tool: "EnterPlanMode" }])).toBe("planning");
  expect(of([{ tool: "mcp__linear__create_issue" }], "file it")).toBe("exploration");
  expect(
    classifyTurn({
      userMessage: "",
      steps: [{ tool: "Skill", skill: "review" }],
      skills: ["review"],
    }),
  ).toMatchObject({ category: "general", skill: "review" });
});

test("a retry is a second edit of a file after a verification command, not after a lookup", () => {
  const retries = (steps: ReadonlyArray<ToolStep>) =>
    classifyTurn({ userMessage: "fix the build", steps, skills: [] }).retries;
  expect(retries([edit(), bash('rg -n "helper" src/'), edit()])).toBe(0);
  expect(retries([edit(), bash("npm test"), edit()])).toBe(1);
  expect(retries([edit(), bash(), edit()])).toBe(1);
  expect(retries([edit(), bash("npm test"), edit(), bash("npm test"), edit()])).toBe(2);
  expect(retries([edit("a.ts"), bash("npm test"), edit("b.ts")])).toBe(0);
  expect(classifyTurn({ userMessage: "", steps: [edit(), edit("b.ts")], skills: [] }).edits).toBe(
    2,
  );
});

test("shell commands reduce to their program names", () => {
  expect(
    commandNames('cd apps && FOO=1 bunx tsc --noEmit && git status | head -5 ; echo "done"'),
  ).toEqual(["tsc", "git", "head"]);
  expect(commandNames("sudo /usr/bin/docker compose up")).toEqual(["docker"]);
  expect(commandNames("for f in *.ts; do wc -l $f; done; if grep -q x y; then rm y; fi")).toEqual([
    "wc",
    "grep",
    "rm",
  ]);
  expect(commandNames("cd web\nbun run build 2>&1 &\nif [ -f x ]; then git status; fi")).toEqual([
    "bun",
    "git",
  ]);
  expect(isReadOnlyCommand("cat notes.txt\nrm -rf build")).toBe(false);
  expect(isReadOnlyCommand("git log --oneline | head")).toBe(true);
  expect(isReadOnlyCommand("cat x && sed -i s/a/b/ x")).toBe(false);
  expect(isReadOnlyCommand("git commit -m x")).toBe(false);
  expect(isReadOnlyCommand("cd src && ls")).toBe(true);
  expect(isReadOnlyCommand("if grep -q x f; then cat f; fi")).toBe(true);
});

test("shell writes and substitutions are not inspections", () => {
  for (const command of [
    "echo x > out.txt && cat f",
    "echo x >> out.txt && cat f",
    "cat f > out.txt",
    'echo "$(touch f)" | cat',
    "echo $(touch f) | cat",
    "echo `touch f` | cat",
    "cat <(touch f)",
    "cat f >&out.txt",
  ]) {
    expect(isReadOnlyCommand(command)).toBe(false);
  }
  for (const command of [
    "cat f 2>&1 | head",
    "cat f 1>&2",
    'echo ">" | cat',
    "echo '$(touch f)' | cat",
    "echo \\> | cat",
  ]) {
    expect(isReadOnlyCommand(command)).toBe(true);
  }
});

test("shell wrappers expose their programs while preserving quoted arguments and writes", () => {
  expect(commandNames("bash -lc 'rg helper src && bun test'")).toEqual(["rg", "bun"]);
  expect(commandNames('/bin/zsh -c "git status | head"')).toEqual(["git", "head"]);
  expect(commandNames("rg 'bash -lc; rm file' src&&cat 'a; b' # fake command\nls")).toEqual([
    "rg",
    "cat",
    "ls",
  ]);
  expect(isReadOnlyCommand("bash -lc 'git status | head'")).toBe(true);
  for (const command of [
    "bash -lc 'cat f > out'",
    "bash -lc 'cat $(touch f)'",
    "bash -lc 'npm test'",
  ])
    expect(isReadOnlyCommand(command)).toBe(false);
});

test("heredoc bodies never become commands, including quoted and tab-stripped delimiters", () => {
  expect(
    commandNames("cat <<'EOF' > script.sh\nrm -rf build\nnpm test\nEOF\nrg helper src"),
  ).toEqual(["cat", "rg"]);
  expect(commandNames("python <<-PY\n\tprint('hello')\n\tPY\ngit status")).toEqual([
    "python",
    "git",
  ]);
  expect(commandNames('cat <<A <<"B"\nfirst body\nA\nsecond body\nB\nls')).toEqual(["cat", "ls"]);
  expect(commandNames("cat <<EOF\nunfinished body\nrm x")).toEqual(["cat"]);
  expect(commandNames("bash -lc 'cat <<EOF\nrm x\nEOF\ngit status'")).toEqual(["cat", "git"]);
  expect(commandNames("grep -c TODO <<< foo\nrm -rf build")).toEqual(["grep", "rm"]);
  expect(isReadOnlyCommand("grep -c TODO <<< foo\nrm -rf build")).toBe(false);
});

test("sed printing is an inspection and cannot turn file edits into retries", () => {
  for (const command of [
    "sed -n '1,120p' src/a.ts",
    "sed -n -e '$p' file",
    "bash -lc \"sed -n '1,2p' src/a.ts\"",
  ]) {
    expect(isReadOnlyCommand(command)).toBe(true);
    expect(
      classifyTurn({ userMessage: "", steps: [edit(), bash(command), edit()], skills: [] }).retries,
    ).toBe(0);
  }
  for (const command of [
    "sed -n -i '1,2p' file",
    "sed -n 'p; w out' file",
    "sed -n 's/a/b/e' file",
    "sed -n '1p' -i file",
  ]) {
    expect(isReadOnlyCommand(command)).toBe(false);
  }
});

test("provider edit names count as edits and unknown file targets do not imply the same file", () => {
  const tools = ["create", "str_replace", "insert", "edit_notebook", "code_action"];
  const classified = classifyTurn({
    userMessage: "",
    steps: tools.map((tool) => ({ tool })),
    skills: [],
  });
  expect(classified).toMatchObject({ category: "coding", edits: tools.length, retries: 0 });
  expect(
    classifyTurn({
      userMessage: "",
      steps: [{ tool: "str_replace" }, bash("npm test"), { tool: "insert" }],
      skills: [],
    }).retries,
  ).toBe(0);
});
