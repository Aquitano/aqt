import type { ReactNode } from "react";

export const Section = ({
  title,
  note,
  action,
  children,
}: {
  readonly title: string;
  readonly note?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) => (
  <section className="min-w-0">
    <div className="mb-1 flex min-h-9 items-center justify-between gap-3 border-b pb-2">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {note !== undefined && <span className="text-xs text-muted-foreground">{note}</span>}
      {action}
    </div>
    {children}
  </section>
);
