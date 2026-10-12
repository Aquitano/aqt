import type { ReactNode } from "react";

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
  <td className="primary">
    {label}
    {sub !== null && <span className="muted"> {sub}</span>}
    <span className="share">
      <i style={{ width: `${Math.min(100, share * 100)}%` }} />
    </span>
  </td>
);
