import { describe, expect, test } from "bun:test";

import { isExcludedPath, redact } from "../src/redact.ts";

describe("redact", () => {
  test("preserves type annotations, delimiters and line breaks", () => {
    for (const input of [
      "def login(username: str, password: str) -> Token:\n    return x",
      "const token: SessionToken",
      "if token:\n    return value",
      "password =\n    nextLine",
      "--token\nnextLine",
    ]) {
      expect(redact(input)).toEqual({ text: input, count: 0 });
      expect(redact(JSON.stringify({ text: input }))).toEqual({
        text: JSON.stringify({ text: input }),
        count: 0,
      });
    }
    expect(redact('login(password="hunter2")\nreturn x')).toEqual({
      text: "login(password=[REDACTED])\nreturn x",
      count: 1,
    });
    expect(redact("login(password=hunter2)\nreturn x")).toEqual({
      text: "login(password=[REDACTED])\nreturn x",
      count: 1,
    });
  });

  test("redacts type-shaped and multiline credentials in transcript text", () => {
    for (const input of [
      "password: Supersecret",
      "db_password: Hunter",
      "password: int",
      "the const password: Supersecret",
      "password:\n  hunter2",
      "  client_secret:\r\n    Supersecret",
    ]) {
      expect(redact(input).count).toBe(1);
      expect(redact(input).text).toContain("[REDACTED]");
      const nested = redact(JSON.stringify({ text: input }));
      expect(nested.count).toBe(1);
      expect(JSON.parse(nested.text).text).toBe(redact(input).text);
    }
  });

  test("redacts credentials after flags and colons, before prose and with brackets inside", () => {
    for (const [input, expected] of [
      ["mysql -u root --password=hunter2 db", "mysql -u root --password=[REDACTED] db"],
      ["java -Dpassword=hunter2 -jar app.jar", "java -Dpassword=[REDACTED] -jar app.jar"],
      ["password: hunter2", "password=[REDACTED]"],
      ["password: hunter2", "password=[REDACTED]"],
      ["PASSWORD: HUNTERTWO", "PASSWORD=[REDACTED]"],
      ["X-Api-Key: abc123def456ghi789", "X-Api-Key=[REDACTED]"],
      ["API_TOKEN=a8f3k2l9x (from the dashboard)", "API_TOKEN=[REDACTED] (from the dashboard)"],
      ["PASSWORD=k8#Lp]2{xQ}9vR", "PASSWORD=[REDACTED]"],
      ["password=)))", "password=[REDACTED]"],
      ["echo $(cmd --token abc123)", "echo $(cmd --token [REDACTED])"],
      ["api_key=[REDACTED]&client_secret=s3cr3tValue9", "api_key=[REDACTED]"],
      [
        "https://gitlab-ci-token:abc123@gitlab.example.com/jobs?private_token=s3cr3tValue9",
        "https://gitlab-ci-token:[REDACTED]@gitlab.example.com/jobs?private_token=[REDACTED]",
      ],
      [
        "git clone https://x-access-token:p@ss@github.com/o/r.git",
        "git clone https://x-access-token:[REDACTED]@github.com/o/r.git",
      ],
      ["https://user:k8#Lp]2{xQ}9vR@host/p", "https://user:[REDACTED]@host/p"],
      ["redis://password=s3cR3t9Xq", "redis://password=[REDACTED]"],
    ] as const) {
      expect(redact(input).text).toBe(expected);
    }
  });

  test("keeps the host and path of clone URLs with credential-like usernames", () => {
    const text = "git clone https://x-access-token:github-secret-value@github.com/o/r.git";
    const expected = "git clone https://x-access-token:[REDACTED]@github.com/o/r.git";
    expect(redact(text)).toEqual({ text: expected, count: 1 });
    expect(redact(JSON.stringify({ text }))).toEqual({
      text: JSON.stringify({ text: expected }),
      count: 1,
    });
    expect(redact(expected)).toEqual({ text: expected, count: 0 });
  });

  test("redacts standalone OpenRouter and service account keys", () => {
    for (const prefix of ["sk-or-v1-", "sk-svcacct-"]) {
      const key = `${prefix}${"a1".repeat(32)}`;
      expect(redact(key)).toEqual({ text: "[REDACTED]", count: 1 });
    }
  });

  test("redacts Turnstash credentials standalone and in enrollment commands", () => {
    const token = `cb_${"a1".repeat(32)}`;
    const command = `turnstash connect --server https://turnstash.example.com --machine-id example --token ${token}`;
    expect(redact(token)).toEqual({ text: "[REDACTED]", count: 1 });
    expect(redact(command)).toEqual({ text: command.replace(token, "[REDACTED]"), count: 1 });
    expect(redact(JSON.stringify({ text: command }))).toEqual({
      text: JSON.stringify({ text: command.replace(token, "[REDACTED]") }),
      count: 1,
    });
  });

  test("replaces known key formats and counts them", () => {
    const input = [
      "anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "github ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "aws AKIAABCDEFGHIJKLMNOP",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      'export OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"',
    ].join("\n");
    const result = redact(input);
    expect(result.text).not.toContain("sk-ant-");
    expect(result.text).not.toContain("ghp_");
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result.text).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result.count).toBe(5);
  });

  test("catches every format behind the trigger test, whatever whitespace follows the scheme", () => {
    const result = redact(
      "Authorization: Bearer\tabcdefghijklmnopqrstuvwxyz0123 and xoxb-123456789012-abcdefghij and pypi-AgEIcHlwaS5vcmcCJDAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMA",
    );
    expect(result.text).toBe("Authorization: Bearer [REDACTED] and [REDACTED] and [REDACTED]");
    expect(result.count).toBe(3);
  });

  test("leaves identifiers, credential-like names, code and existing redactions alone", () => {
    const redacted = redact(JSON.stringify({ text: "API_TOKEN=abcdefgh", password: "abcdefgh" }));
    for (const input of [
      "commit 62c7f8981a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d session 01a005d6-001b-7d0e-8805-44d171905464 const apiKeyName = 'primary'; key=value; messageKey=msg-1",
      "tokens=12 keyboard=qwerty monkey=banana passwords_page=/settings https://user@example.com/x http://localhost:8080/api",
      '{ "key": "bubbleId:123", "messageKey": "msg-1", "keyboard": "qwerty", "text": "ordinary code", "usage": { "input_tokens": 12 } }',
      [
        "let token: string; password?: null",
        "const token = randomBytes(32); const apiKey = config.apiKey;",
        "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD} and PGPASSWORD=$PG_PASSWORD",
        "password = process.env.PG_PASSWORD; const accessToken: newToken",
        "record_key: 1, public_key: abc, pad_token: x",
        "token: [REDACTED] and postgres://user:${DB_PASSWORD}@db/app",
        "--max-tokens 4096 --token-file ~/.token --password-stdin",
      ].join("\n"),
      redacted.text,
    ]) {
      expect(redact(input)).toEqual({ text: input, count: 0 });
    }
  });

  test("redacts mixed-case credential assignments and authorization schemes inside transcript text", () => {
    const text =
      'password=hunter2 api_token=abcdefgh Client_Secret="hello world" Authorization: bearer abcdefghijklmnopqrstuvwxyz0123 Authorization: bAsIc abcdefghijklmnopqrstuvwxyz0123';
    const expected =
      "password=[REDACTED] api_token=[REDACTED] Client_Secret=[REDACTED] Authorization: bearer [REDACTED] Authorization: bAsIc [REDACTED]";
    expect(redact(text)).toEqual({ text: expected, count: 5 });
    expect(redact(JSON.stringify({ text }))).toEqual({
      text: JSON.stringify({ text: expected }),
      count: 5,
    });
  });
});

test("redacts connection-string passwords and credential names in any case or separator", () => {
  const text = [
    "DATABASE_URL=postgres://admin:hunter2supersecret@db.internal:5432/app",
    "git clone https://user:ghostpassword123@git.example.com/repo.git",
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG",
  ].join("\n");
  expect(redact(text)).toEqual({
    text: [
      "DATABASE_URL=postgres://admin:[REDACTED]@db.internal:5432/app",
      "git clone https://user:[REDACTED]@git.example.com/repo.git",
      "aws_secret_access_key=[REDACTED]",
    ].join("\n"),
    count: 3,
  });
  expect(redact(JSON.stringify({ PGPASSWORD: "pw", "x-api-key": "k", model: "m" }))).toEqual({
    text: JSON.stringify({ PGPASSWORD: "[REDACTED]", "x-api-key": "[REDACTED]", model: "m" }),
    count: 2,
  });
});

describe("isExcludedPath", () => {
  test("flags credential files", () => {
    expect(isExcludedPath("/home/u/.claude/auth.json")).toBe(true);
    expect(isExcludedPath("C:\\Users\\u\\.codex\\credentials.json")).toBe(true);
    expect(isExcludedPath("/home/u/.ssh/id_rsa")).toBe(true);
    expect(isExcludedPath("/home/u/.claude/projects/a/session.jsonl")).toBe(false);
  });
});

test("redacts JSON values and nested SQLite payloads without changing their structure", () => {
  const input = JSON.stringify({
    text: 'API_TOKEN=abcdefgh and export OTHER_SECRET="hello world"',
    password: "short",
    value: JSON.stringify({
      text: "PASSWORD=abcdefgh",
      API_TOKEN: "credential",
      usage: { input_tokens: 12 },
    }),
    parts: [{ text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD" }],
  });
  const result = redact(input);
  const parsed = JSON.parse(result.text);
  expect(parsed.text).toBe("API_TOKEN=[REDACTED] and export OTHER_SECRET=[REDACTED]");
  expect(parsed.password).toBe("[REDACTED]");
  expect(JSON.parse(parsed.value)).toEqual({
    text: "PASSWORD=[REDACTED]",
    API_TOKEN: "[REDACTED]",
    usage: { input_tokens: 12 },
  });
  expect(parsed.parts).toEqual([{ text: "[REDACTED]" }]);
  expect(result.count).toBe(6);
});

test("redacts escaped credentials inside nested objects and arrays", () => {
  const input = String.raw`{ "nested": { "label": "ordinary", "value": [{"to\u006ben": "abc", "text": "s\u006b-abcdefghijklmnopqrstuvwxyz"}] } }`;
  expect(redact(input)).toEqual({
    text: String.raw`{ "nested": { "label": "ordinary", "value": [{"to\u006ben": "[REDACTED]", "text": "[REDACTED]"}] } }`,
    count: 2,
  });
});

test("redacts complete quoted assignments with escaped quotes", () => {
  for (const value of [String.raw`"prefix\"still-secret"`, String.raw`'prefix\'still-secret'`]) {
    expect(redact(`API_TOKEN=${value}`)).toEqual({ text: "API_TOKEN=[REDACTED]", count: 1 });
  }
});

test("redacts truncated private keys without rescanning each opening header", () => {
  const input = "-----BEGIN PRIVATE KEY-----\n".repeat(16_000);
  const started = performance.now();
  expect(redact(input)).toEqual({ text: "[REDACTED]", count: 1 });
  expect(performance.now() - started).toBeLessThan(1000);
});

test("preserves JSON numbers and handles deeply nested records while redacting", () => {
  const input =
    '{ "id": 9007199254740993, "secret": "abc", "nested": { "text": "API_TOKEN=abc" } }';
  expect(redact(input)).toEqual({
    text: '{ "id": 9007199254740993, "secret": "[REDACTED]", "nested": { "text": "API_TOKEN=[REDACTED]" } }',
    count: 2,
  });
  expect(redact('{ "big": 1e400, "token": "abc.def" }')).toEqual({
    text: '{ "big": 1e400, "token": "[REDACTED]" }',
    count: 1,
  });
  const deep = "[".repeat(20_000) + '{"password":"abc"}' + "]".repeat(20_000);
  expect(redact(deep)).toEqual({ text: deep.replace('"abc"', '"[REDACTED]"'), count: 1 });
});

test("redacts JSON values that follow a multi-megabyte string", () => {
  const input = JSON.stringify({ output: "x".repeat(5 * 1024 * 1024), password: "abc" });
  expect(redact(input)).toEqual({ text: input.replace('"abc"', '"[REDACTED]"'), count: 1 });
});

test("redacts quoted keys in plain text, credential flags and pass-suffixed names", () => {
  const text = [
    '  12  "apiKey": "k3y-v4lue-9x",',
    "turnstash enroll --server https://t.example --admin-token s3cr3t-admin-value",
    "psql --password hunter2 && DB_PASS=hunter3",
  ].join("\n");
  expect(redact(text)).toEqual({
    text: [
      '  12  "apiKey": "[REDACTED]",',
      "turnstash enroll --server https://t.example --admin-token [REDACTED]",
      "psql --password [REDACTED] && DB_PASS=[REDACTED]",
    ].join("\n"),
    count: 4,
  });
});
