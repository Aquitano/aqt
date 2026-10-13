import type { ReactNode } from "react";

import { PrimaryTd } from "./DataTable";

export const shareOf = (value: number, total: number) => (total > 0 ? value / total : 0);

export const totalCost = (rows: ReadonlyArray<{ readonly costUsd: number }>) =>
  rows.reduce((sum, row) => sum + row.costUsd, 0);

export const ShareCell = ({
  label,
  share,
  sub = null,
}: {
  readonly label: ReactNode;
  readonly share: number;
  readonly sub?: string | null;
}) => (
  <PrimaryTd>
    {label}
    {sub !== null && <span className="text-xs text-muted-foreground"> {sub}</span>}
    <span className="mt-1 block h-0.5 overflow-hidden bg-muted">
      <span
        className="block h-full bg-primary"
        style={{ width: `${Math.min(100, share * 100)}%` }}
      />
    </span>
  </PrimaryTd>
);
