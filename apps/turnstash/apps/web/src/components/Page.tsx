import type { ReactNode } from "react";

export const Page = ({ children }: { readonly children: ReactNode }) => (
  <main className="mx-auto flex w-full max-w-310 min-w-0 flex-1 flex-col gap-9 px-4 pt-7 pb-12 sm:px-6">
    {children}
  </main>
);

// Conversation titles are often a pasted prompt, so the heading stops at two lines.
export const PageHead = ({
  title,
  note,
}: {
  readonly title: ReactNode;
  readonly note?: ReactNode;
}) => (
  <div className="flex flex-wrap items-baseline justify-between gap-4">
    <h1 className="line-clamp-2 min-w-0 text-[22px] leading-tight font-semibold tracking-tight wrap-anywhere">
      {title}
    </h1>
    {note !== undefined && <span className="text-[13px] text-muted-foreground">{note}</span>}
  </div>
);
