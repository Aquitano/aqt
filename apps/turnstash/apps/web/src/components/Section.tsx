import { cn } from "cn";
import type { ReactNode } from "react";

export const surface =
  "min-w-0 rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/7 dark:shadow-none";

export const sectionTitle = "text-sm font-semibold tracking-tight";

export const Section = ({
  title,
  note,
  description,
  action,
  className,
  children,
}: {
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) => (
  <section className={cn(surface, "p-4 sm:p-5", className)}>
    <div className="mb-3 flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2 className={sectionTitle}>{title}</h2>
          {note !== undefined && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
        {description !== undefined && (
          <p className="max-w-prose text-xs text-pretty text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
    {children}
  </section>
);

export const SectionGroup = ({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}) => (
  <div className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-col gap-0.5 pt-2">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {description !== undefined && (
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">{description}</p>
      )}
    </div>
    {children}
  </div>
);

export const SectionEmpty = ({ children }: { readonly children: ReactNode }) => (
  <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
    {children}
  </p>
);
