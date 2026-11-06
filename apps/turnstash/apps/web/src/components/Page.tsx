import type { ReactNode } from "react";

export const Page = ({ children }: { readonly children: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-320 min-w-0 flex-1 flex-col gap-5 px-4 pt-4 pb-12 sm:px-8">
    {children}
  </div>
);

// Conversation titles are often a pasted prompt, so the heading stops at two lines.
export const PageHead = ({
  title,
  note,
  actions,
}: {
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly actions?: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="line-clamp-2 min-w-0 text-[26px] leading-tight font-semibold tracking-tight wrap-anywhere">
        {title}
      </h1>
      {note !== undefined && <span className="text-muted-foreground">{note}</span>}
    </div>
    {actions}
  </div>
);
