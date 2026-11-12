import type { DayRow } from "@aqt/turnstash-api";
import { renderToStaticMarkup } from "react-dom/server";
import type { TooltipValueType } from "recharts";
import { expect, test } from "vite-plus/test";

import { chartRow } from "../src/components/ChartRow";
import { dailyAxisKey } from "../src/components/DailyChart";
import { missing, usd } from "../src/format";
import { withQuietDays } from "../src/period";

const costCell = (value: TooltipValueType | null | undefined) =>
  renderToStaticMarkup(
    <>{chartRow(usd)(value, "Cost", { graphicalItemId: "cost", color: "red" })}</>,
  ).match(/tabular-nums">([^<]*)</)?.[1];

const day = (date: string, costUsd: number): DayRow => ({
  date,
  requests: 1,
  conversations: 1,
  costUsd,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

test("a day's tooltip shows that day's cost on a chart longer than a year", () => {
  const days = withQuietDays([day("2025-11-06", 0.04), day("2026-11-07", 583.486855)]);
  const hovered = days.at(-1);
  if (hovered === undefined) throw new Error("No days");
  // Recharts resolves the tooltip row as the first row whose axis value equals the hovered one.
  const row = days.find((candidate) => candidate[dailyAxisKey] === hovered[dailyAxisKey]);
  expect(row?.date).toBe("2026-11-07");
  expect(costCell(row?.costUsd)).toBe("$583.49");
});

test("tooltip costs never pass missing data or a fraction of a cent off as zero", () => {
  expect(costCell(0)).toBe("$0.00");
  expect(costCell(0.003)).toBe("&lt;$0.01");
  expect(costCell(undefined)).toBe(missing);
  expect(costCell(null)).toBe(missing);
  expect(costCell(Number.NaN)).toBe(missing);
  expect(costCell("")).toBe(missing);
  expect(costCell([100, 683.486855])).toBe("$583.49");
  expect(costCell([0, Number.NaN])).toBe(missing);
});
