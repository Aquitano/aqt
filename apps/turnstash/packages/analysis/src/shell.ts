const ansi = /\u001b\[[0-9;]*[A-Za-z]/g;
const prefixes = new Set([
  "sudo",
  "doas",
  "npx",
  "bunx",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "rtk",
  "env",
]);
// Keywords that introduce a command, as in `if grep -q x f` or `do cat $f`, and keywords that
// never are one, like a `for` header or a closing `done`.
const leadingKeywords = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
const skipped = new Set([
  "cd",
  "true",
  "false",
  "echo",
  "for",
  "select",
  "case",
  "done",
  "fi",
  "esac",
  "}",
  "[",
  "[[",
  "test",
]);

const baseName = (token: string): string => token.slice(token.lastIndexOf("/") + 1);

const segmentsOf = (raw: string): Array<Array<string>> => {
  const segments: Array<Array<string>> = [];
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let tokens: Array<string> = [];
  let token = "";
  let quote = "";
  const flushToken = () => {
    if (token !== "") tokens.push(token);
    token = "";
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] ?? "";
    if (character === "\\" && quote !== "'") {
      const next = raw[index + 1];
      if (next !== undefined && (quote === "" || /[$`"\\\n]/.test(next))) {
        if (next !== "\n") token += next;
        index += 1;
        continue;
      }
    }
    if (quote !== "") {
      if (character === quote) quote = "";
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && token === "") {
      const end = raw.indexOf("\n", index);
      index = end < 0 ? raw.length : end - 1;
      continue;
    }
    if (raw.startsWith("<<<", index)) {
      token += "<<<";
      index += 2;
      continue;
    }
    if (raw.startsWith("<<", index)) {
      const match = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(raw.slice(index));
      if (match !== null) {
        flushToken();
        heredocs.push({ delimiter: match[3] ?? "", stripTabs: match[1] === "-" });
        index += match[0].length - 1;
        continue;
      }
    }
    // A lone `&` backgrounds a command; the `&` in redirections like `2>&1` and `&>` does not separate.
    const separates =
      character === ";" ||
      character === "|" ||
      character === "\n" ||
      (character === "&" &&
        (raw[index + 1] === "&" ||
          (!/[<>]/.test(raw[index - 1] ?? "") && !/[>&]/.test(raw[index + 1] ?? ""))));
    if (separates) {
      flushSegment();
      if ((character === "&" || character === "|") && raw[index + 1] === character) index += 1;
      if (character === "\n") {
        for (const { delimiter, stripTabs } of heredocs) {
          while (index + 1 < raw.length) {
            const end = raw.indexOf("\n", index + 1);
            const line = raw.slice(index + 1, end < 0 ? raw.length : end).replace(/\r$/, "");
            index = end < 0 ? raw.length : end;
            if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
          }
        }
        heredocs.length = 0;
      }
    } else if (/\s/.test(character)) flushToken();
    else token += character;
  }
  flushSegment();
  return segments;
};

interface Command {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
}

const commandOfSegment = (tokens: ReadonlyArray<string>): Command | null => {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1];
    if (/^\w+=/.test(token) || leadingKeywords.has(token)) {
      index += 1;
      continue;
    }
    if (prefixes.has(baseName(token)) && next !== undefined && !next.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const name = baseName(tokens[index] ?? "");
  return name === "" || skipped.has(name) ? null : { name, args: tokens.slice(index + 1) };
};

const commandsOf = (raw: string): Array<Command> =>
  segmentsOf(raw.replace(ansi, "")).flatMap((segment) => commandOfSegment(segment) ?? []);

const shells = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const maxShellDepth = 8;
const shellScript = ({ name, args }: Command): string | undefined => {
  if (!shells.has(name)) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) break;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) || arg === "--command") return args[index + 1];
  }
  return undefined;
};
const namesOf = (raw: string, depth: number): Array<string> =>
  commandsOf(raw).flatMap((command) => {
    const script = shellScript(command);
    return script === undefined || depth >= maxShellDepth
      ? [command.name]
      : namesOf(script, depth + 1);
  });

export const commandNames = (raw: string): Array<string> => [...new Set(namesOf(raw, 0))];

const readOnly = new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "ls",
  "find",
  "fd",
  "tree",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "which",
  "type",
  "pwd",
  "printenv",
  "env",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "jq",
  "diff",
]);
const gitReadSubcommands = new Set([
  "log",
  "diff",
  "status",
  "show",
  "blame",
  "grep",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
]);

const hasWriteOrSubstitution = (raw: string): boolean => {
  let quote = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = "";
      continue;
    }
    if (character === "'" && quote === "") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === "" ? '"' : "";
      continue;
    }
    if (character === "`" || (character === "$" && raw[index + 1] === "(")) return true;
    if (quote !== "") continue;
    if (character === "<" && raw[index + 1] === "(") return true;
    if (character === ">") {
      if (raw[index + 1] !== "&" || !/^(?:\d+-?|-)(?=\s|[;&|)]|$)/.test(raw.slice(index + 2)))
        return true;
    }
  }
  return quote !== "";
};

const isSedInspection = (args: ReadonlyArray<string>): boolean => {
  if (args[0] !== "-n" && args[0] !== "--quiet" && args[0] !== "--silent") return false;
  const scriptIndex = args[1] === "-e" ? 2 : 1;
  const script = args[scriptIndex] ?? "";
  return (
    /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?p$/.test(script) &&
    args.slice(scriptIndex + 1).every((arg) => arg === "--" || !arg.startsWith("-"))
  );
};

// Every command must be an inspection; an unknown command keeps the conservative non-read answer.
const readOnlyCommand = (raw: string, depth: number): boolean => {
  if (hasWriteOrSubstitution(raw.replace(ansi, ""))) return false;
  const commands = commandsOf(raw);
  return (
    commands.length > 0 &&
    commands.every((command) => {
      const script = shellScript(command);
      if (script !== undefined) return depth < maxShellDepth && readOnlyCommand(script, depth + 1);
      const { name, args } = command;
      if (name === "sed") return isSedInspection(args);
      return name === "git" ? gitReadSubcommands.has(args[0] ?? "") : readOnly.has(name);
    })
  );
};

export const isReadOnlyCommand = (raw: string): boolean => readOnlyCommand(raw, 0);
