import type { ReactNode } from "react";
import type { TooltipPayloadEntry, TooltipValueType } from "recharts";

/** A tooltip row like the default one, with the value formatted for its unit. */
export const chartRow =
  (format: (value: number) => string) =>
  (
    value: TooltipValueType | undefined,
    name: string | number | undefined,
    item: TooltipPayloadEntry,
  ): ReactNode => (
    <>
      <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} />
      <span className="flex flex-1 items-center justify-between gap-4 leading-none">
        <span className="text-muted-foreground">{name}</span>
        <span className="font-mono font-medium text-foreground tabular-nums">
          {format(Number(value))}
        </span>
      </span>
    </>
  );
