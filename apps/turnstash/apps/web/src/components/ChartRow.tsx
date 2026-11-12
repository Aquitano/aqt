import type { ReactNode } from "react";
import type { TooltipPayloadEntry, TooltipValueType } from "recharts";

import { missing } from "../format";

const finite = (value: number | string): number | null => {
  if (String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// A stacked series may report its [base, top] range. Its own amount is the difference, never the
// cumulative top.
export const tooltipAmount = (value: TooltipValueType | null | undefined): number | null => {
  if (value == null) return null;
  const parts = new Array<number | string>().concat(value).map(finite);
  const [first, second] = parts;
  if (parts.length === 1) return first ?? null;
  return parts.length === 2 && first != null && second != null ? second - first : null;
};

/** A tooltip row like the default one, with the value formatted for its unit. */
export const chartRow =
  (format: (value: number) => string) =>
  (
    value: TooltipValueType | null | undefined,
    name: string | number | undefined,
    item: TooltipPayloadEntry,
  ): ReactNode => {
    const amount = tooltipAmount(value);
    return (
      <>
        <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} />
        <span className="flex flex-1 items-center justify-between gap-4 leading-none">
          <span className="text-muted-foreground">{name}</span>
          <span className="font-mono font-medium text-foreground tabular-nums">
            {amount === null ? missing : format(amount)}
          </span>
        </span>
      </>
    );
  };
