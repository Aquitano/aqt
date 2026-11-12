import type { ReactNode } from "react";

export const Page = ({ children }: { readonly children: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-320 min-w-0 flex-1 flex-col gap-6 px-4 pt-6 pb-16 sm:px-8 sm:pt-8">
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
  <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
    <div className="flex min-w-0 flex-col gap-1">
      <h1 className="line-clamp-2 min-w-0 text-2xl leading-tight font-semibold tracking-tight wrap-anywhere sm:text-[28px]">
        {title}
      </h1>
      {note !== undefined && <div className="text-sm text-muted-foreground">{note}</div>}
    </div>
    {actions}
  </div>
);
