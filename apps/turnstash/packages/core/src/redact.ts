import { Predicate, type Schema } from "effect";

import { isJsonObject, parseJson } from "./json.ts";

const placeholder = "[REDACTED]";

// One rule for JSON keys and `name=value` text. Bare `key` and `pass` suffixes need a separator so
// names like monkey, messageKey, keyboard and compass stay readable.
const credentialName = String.raw`[a-z0-9_-]*(?:password|passwd|secret|token)|[a-z0-9_-]*[_-](?:key|pass)|(?:api|access|secret|private)key`;

// Names that end like a credential but hold database keys, public keys or tokenizer tokens.
const benignName =
  /(?:^|[_-])(?:record|primary|foreign|sort|partition|cache|idempotency|public)[_-]key$|(?:^|[_-])(?:pad|eos|bos|unk|sep|cls|mask|page|next)[_-]?token$/i;

const credentialPattern = new RegExp(`^(?:${credentialName})$`, "i");
const isCredentialName = (name: string) => credentialPattern.test(name) && !benignName.test(name);

const quotedValue = String.raw`"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'`;

// Whitespace that does not end the line, so a name at the end of one line never takes the next line as its value.
const blank = String.raw`[^\S\r\n]`;

// The name may be quoted, as in a JSON config pasted into plain text. A name that is a URL's username, as in
// `https://x-access-token:secret@host`, is left to urlPasswordPattern so the host and path survive. Both
// scans around it are bounded because unbounded ones rescan the line at every position.
const assignmentPattern = new RegExp(
  String.raw`(?!(?<=:\/\/[\w.~%+-]{0,64})(?:${credentialName}):[^\s/]{0,256}@)\b(${credentialName})(["']?)${blank}*([=:])${blank}*(${quotedValue}|[^\s"'\\,;]+)`,
  "gi",
);

const multilineAssignmentPattern = new RegExp(
  String.raw`^(${blank}*)(["']?)(${credentialName})\2(${blank}*:${blank}*\r?\n${blank}+)(${quotedValue}|[^\s"'\\,;]+)`,
  "gmi",
);

// A credential flag followed by its value, as in `turnstash enroll --admin-token <value>`.
const flagPattern = new RegExp(
  String.raw`(--[a-z0-9-]*(?:password|passwd|secret|token|api-key|apikey|access-key|private-key))${blank}+(${quotedValue}|[^\s"'\\;|&]+)`,
  "gi",
);

// Values that name or compute a credential rather than contain one: templates and variables, env
// lookups, and member chains or calls such as `config.token` or `randomBytes(32)`.
const referenceValue =
  /^(?:$|[$%<{(`]|process\.env|os\.environ|Bun\.env|import\.meta\.env|(?:null|undefined|true|false|none)$|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*[([])/i;

const unquote = (value: string) => (/^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value);

const isSecretValue = (value: string, separator: string, code = false) => {
  const inner = unquote(value);
  if (inner === placeholder || referenceValue.test(inner)) return false;
  return !(
    code &&
    separator === ":" &&
    inner === value &&
    /^(?:string|str|number|int|float|boolean|bool|bytes|any|unknown|void|never|object|(?:[A-Z][a-z]|[a-z]+[A-Z])[A-Za-z]*)$/.test(
      inner,
    )
  );
};

const openers = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

const occurrences = (text: string, char: string) => text.split(char).length - 1;

// A bare value stops before closing brackets it did not open, as in `login(password=hunter2)`, while
// brackets inside a password, or a password made only of closers, stay redacted.
const splitClosers = (value: string): readonly [string, string] => {
  const unmatched = new Map(
    [...openers].map(([closer, opener]) => [
      closer,
      occurrences(value, closer) - occurrences(value, opener),
    ]),
  );
  let end = value.length;
  for (;;) {
    const closer = value.charAt(end - 1);
    const excess = unmatched.get(closer) ?? 0;
    if (excess <= 0) break;
    unmatched.set(closer, excess - 1);
    end -= 1;
  }
  return end === 0 ? [value, ""] : [value.slice(0, end), value.slice(end)];
};

// Keeps the scheme, user and host of `scheme://user:password@host` and drops only the password, which
// ends at the last `@` before the path because a password may contain `@`.
const urlPasswordPattern = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s/]+)@/gi;

// Every pattern below needs one of these literals, so most strings skip the pattern loop after one cheap test.
const trigger =
  /KEY|TOKEN|SECRET|PASS|:\/\/[^\s:@/]*:[^\s@/]+@|cb_|sk-|sk_|pk_|gh[opusr]_|github_pat_|xox[abprs]-|AKIA|AIza|glpat-|npm_|pypi-|SG\.|\.ey|PRIVATE KEY|Bearer|Basic/i;

const patterns: ReadonlyArray<RegExp> = [
  urlPasswordPattern,
  assignmentPattern,
  multilineAssignmentPattern,
  flagPattern,
  /\bcb_[a-f0-9]{64}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:or-v1|svcacct)-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bpypi-[A-Za-z0-9_-]{40,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /\bpk_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

export interface Redacted {
  readonly text: string;
  readonly count: number;
}

const redactText = (input: string): Redacted => {
  if (!trigger.test(input)) return { text: input, count: 0 };
  let count = 0;
  let text = input;
  for (const pattern of patterns) {
    text = text.replace(pattern, (match, ...groups: ReadonlyArray<unknown>) => {
      if (pattern === urlPasswordPattern) {
        const password = String(groups[1]);
        if (password === placeholder || /^[$%<{]/.test(password)) return match;
        count += 1;
        return `${String(groups[0])}${placeholder}@`;
      }
      if (pattern === assignmentPattern) {
        const name = String(groups[0]);
        const nameQuote = String(groups[1]);
        const separator = String(groups[2]);
        const [value, rest] = splitClosers(String(groups[3]));
        const offset = Number(groups[4]);
        const prefix = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
        const code =
          /(?:^|;)\s*(?:(?:export|declare|async)\s+)*(?:const|let|var|function|def)\s/.test(prefix);
        if (benignName.test(name) || !isSecretValue(value, separator, code)) return match;
        count += 1;
        if (nameQuote === "") return `${name}=${placeholder}${rest}`;
        const valueQuote = /^["']/.test(value) ? value.charAt(0) : "";
        return `${name}${nameQuote}${separator} ${valueQuote}${placeholder}${valueQuote}${rest}`;
      }
      if (pattern === multilineAssignmentPattern) {
        const name = String(groups[2]);
        const [value, rest] = splitClosers(String(groups[4]));
        if (benignName.test(name) || !isSecretValue(value, ":")) return match;
        count += 1;
        const valueQuote = /^["']/.test(value) ? value.charAt(0) : "";
        return `${String(groups[0])}${String(groups[1])}${name}${String(groups[1])}${String(groups[3])}${valueQuote}${placeholder}${valueQuote}${rest}`;
      }
      if (pattern === flagPattern) {
        const [value, rest] = splitClosers(String(groups[1]));
        if (value.startsWith("-") || !isSecretValue(value, " ")) return match;
        count += 1;
        return `${String(groups[0])} ${placeholder}${rest}`;
      }
      count += 1;
      return /^(?:Bearer|Basic)\s/i.test(match)
        ? `${match.split(/\s+/)[0]} ${placeholder}`
        : placeholder;
    });
  }
  return { text, count };
};

const needsRedaction = (parsed: Schema.Json): boolean => {
  const pending = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Predicate.isString(value)) {
      if (redact(value).count > 0) return true;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isJsonObject(value)) {
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (item === undefined) continue;
        if (
          isCredentialName(key) &&
          Predicate.isString(item) &&
          item !== "" &&
          item !== placeholder
        )
          return true;
        pending.push(item);
      }
    }
  }
  return false;
};

export const redact = (input: string): Redacted => {
  const first = input.trimStart()[0];
  if (first !== "{" && first !== "[" && first !== '"') return redactText(input);
  const parsed = parseJson(input);
  if (parsed === undefined) return redactText(input);
  if (!needsRedaction(parsed)) return { text: input, count: 0 };
  let count = 0;
  let credentialEnd: number | null = null;
  // Replace only string tokens so JSON numbers and deep nesting survive unchanged.
  const text = input.replace(
    /("[^"\\]*(?:\\.[^"\\]*)*")(\s*:)?/g,
    (token: string, quoted: string, colon: string | undefined, offset: number) => {
      const value: string = quoted.includes("\\") ? JSON.parse(quoted) : quoted.slice(1, -1);
      if (colon !== undefined) {
        credentialEnd = isCredentialName(value) ? offset + token.length : null;
        return token;
      }
      const credential = credentialEnd !== null && /^\s*$/.test(input.slice(credentialEnd, offset));
      credentialEnd = null;
      if (credential && value !== "" && value !== placeholder) {
        count += 1;
        return JSON.stringify(placeholder);
      }
      const result = redact(value);
      count += result.count;
      return result.count === 0 ? token : JSON.stringify(result.text);
    },
  );
  return { text, count };
};

const excludedNames = new Set([
  "auth.json",
  "credentials.json",
  "credentials",
  ".credentials.json",
  ".env",
  "id_rsa",
  "id_ed25519",
]);

export const isExcludedPath = (path: string): boolean => {
  const base = path.split(/[\\/]/).pop() ?? path;
  if (excludedNames.has(base)) return true;
  if (base.startsWith(".env.")) return true;
  return /\.(pem|key|p12|pfx|keychain)$/i.test(base);
};
