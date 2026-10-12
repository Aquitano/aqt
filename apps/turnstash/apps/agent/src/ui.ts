import { styleText } from "node:util";

import { Clock, Duration, Effect, Fiber, Ref, Schedule } from "effect";

export const dim = (text: string) => styleText("dim", text);
export const bold = (text: string) => styleText("bold", text);

export const mark = {
  done: styleText("green", "✓"),
  warn: styleText("yellow", "!"),
  fail: styleText("red", "✗"),
  idle: dim("–"),
} as const;

const numbers = new Intl.NumberFormat("en-US");

export const formatNumber = (value: number) => numbers.format(value);

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatUsd = (value: number) => dollars.format(value);

const timestamps = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export const formatTime = (iso: string) => timestamps.format(Date.parse(iso));

export const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const count = (value: number, singular: string, plural = `${singular}s`) =>
  `${formatNumber(value)} ${value === 1 ? singular : plural}`;

const byteUnits = ["bytes", "KiB", "MiB", "GiB"] as const;

export const formatBytes = (bytes: number) => {
  const exponent = Math.min(
    byteUnits.length - 1,
    Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)),
  );
  return exponent === 0
    ? count(bytes, "byte")
    : `${(bytes / 1024 ** exponent).toFixed(1)} ${byteUnits[exponent]}`;
};

const relativeUnits: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export const ago = (iso: string, nowMillis: number) => {
  const seconds = (Date.parse(iso) - nowMillis) / 1000;
  const [unit, size] = relativeUnits.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(seconds / size),
    unit,
  );
};

export const tildify = (path: string, home: string) =>
  home !== "" && path.startsWith(home) && /^([/\\]|$)/.test(path.slice(home.length))
    ? `~${path.slice(home.length)}`
    : path;

// Console.log dropped whatever did not fit the 64 KiB pipe buffer, so long output piped to another
// program was cut off. Writing through the stream and waiting for its callback delivers all of it.
export const print = (lines: ReadonlyArray<string | null>) =>
  Effect.callback<void>((resume) => {
    process.stdout.write(`${lines.filter((line) => line !== null).join("\n")}\n`, () =>
      resume(Effect.void),
    );
  });

export const section = (title: string, lines: ReadonlyArray<string | null>) => [
  "",
  bold(title),
  ...lines.map((line) => (line === null ? null : `  ${line}`)),
];

// Widths are measured without ANSI styles, so cells can be styled before they are aligned.
export const table = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  align: ReadonlyArray<"left" | "right"> = [],
) => {
  const widths = rows.reduce<ReadonlyArray<number>>(
    (max, row) => row.map((cell, column) => Math.max(max[column] ?? 0, Bun.stringWidth(cell))),
    [],
  );
  return rows.map((row) =>
    row
      .map((cell, column) => {
        const padding = " ".repeat((widths[column] ?? 0) - Bun.stringWidth(cell));
        return align[column] === "right" ? padding + cell : cell + padding;
      })
      .join("  ")
      .trimEnd(),
  );
};

export interface Progress {
  readonly done: number;
  readonly total: number;
}

export type Report = (label: string, progress?: Progress) => Effect.Effect<void>;

const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const frameMillis = 80;
const barWidth = 20;

const progressBar = ({ done, total }: Progress) => {
  const filled = total === 0 ? barWidth : Math.round((Math.min(done, total) / total) * barWidth);
  const bar = styleText("cyan", "━".repeat(filled)) + dim("━".repeat(barWidth - filled));
  return `${bar} ${formatNumber(done)}/${formatNumber(total)}`;
};

// The spinner only draws on a terminal. Scheduled syncs write to a log file, where redrawn frames
// would be noise, so there the body runs silently and only the lines printed after it appear.
export const withSpinner = <A, E, R>(
  label: string,
  body: (report: Report) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const output = process.stdout;
  if (!output.isTTY) return body(() => Effect.void);
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const current = yield* Ref.make<{ label: string; progress?: Progress | undefined }>({
        label,
      });
      const started = yield* Clock.currentTimeMillis;
      const draw = Effect.gen(function* () {
        const { label, progress } = yield* Ref.get(current);
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        const frame = styleText(
          "cyan",
          frames.charAt(Math.floor(elapsed / frameMillis) % frames.length),
        );
        const line = [
          `${frame} ${label}`,
          progress === undefined ? null : progressBar(progress),
          elapsed < 1000 ? null : dim(`${Math.floor(elapsed / 1000)}s`),
        ]
          .filter((part) => part !== null)
          .join("  ");
        const width = output.columns || 80;
        yield* Effect.sync(() =>
          output.write(
            `\r\x1b[2K${Bun.stringWidth(line) < width ? line : `${frame} ${label.slice(0, width - 3)}`}`,
          ),
        );
      });
      yield* Effect.sync(() => output.write("\x1b[?25l"));
      const spinner = yield* draw.pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(frameMillis))),
        Effect.forkChild,
      );
      return { current, spinner };
    }),
    ({ current }) => body((label, progress) => Ref.set(current, { label, progress })),
    ({ spinner }) =>
      Fiber.interrupt(spinner).pipe(
        Effect.andThen(Effect.sync(() => output.write("\r\x1b[2K\x1b[?25h"))),
      ),
  );
};

export type Summary = readonly [headline: string, ...details: ReadonlyArray<string | null>];

export const step = <A, E, R>(
  label: string,
  body: (report: Report) => Effect.Effect<A, E, R>,
  describe: (result: A) => Summary,
) =>
  withSpinner(label, body).pipe(
    Effect.timed,
    Effect.flatMap(([took, result]) => {
      const [headline, ...details] = describe(result);
      const seconds = (Duration.toMillis(took) / 1000).toFixed(1);
      return print([
        `${mark.done} ${headline} ${dim(`${seconds}s`)}`,
        ...details.map((detail) => (detail === null ? null : `  ${detail}`)),
      ]).pipe(Effect.as(result));
    }),
  );
