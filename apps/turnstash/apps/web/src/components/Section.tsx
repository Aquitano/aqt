import { cn } from "cn";
import type { ReactNode } from "react";

export const surface = "min-w-0 rounded-xl bg-card text-card-foreground ring-1 ring-foreground/6";

export const Section = ({
  title,
  note,
  action,
  className,
  children,
}: {
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) => (
  <section className={cn(surface, "p-4 sm:p-5", className)}>
    <div className="mb-2.5 flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
        <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
        {note !== undefined && <span className="text-[13px] text-muted-foreground">{note}</span>}
      </div>
      {action}
    </div>
    {children}
  </section>
);
