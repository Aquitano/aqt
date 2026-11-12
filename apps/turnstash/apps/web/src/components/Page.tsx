import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

export const Page = ({ children }: { readonly children: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-320 min-w-0 flex-1 flex-col gap-6 px-4 pt-6 pb-16 sm:px-8 sm:pt-8">
    {children}
  </div>
);

export const BackLink = ({
  to,
  children,
}: {
  readonly to: "/conversations";
  readonly children: ReactNode;
}) => (
  <Link
    to={to}
    className="-ml-1 inline-flex w-fit items-center gap-0.5 rounded-md py-0.5 pr-1.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
  >
    <ChevronLeftIcon className="size-4" aria-hidden="true" />
    {children}
  </Link>
);

// Conversation titles are often a pasted prompt, so the heading stops at two lines.
export const PageHead = ({
  title,
  note,
  back,
  meta,
  actions,
}: {
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly back?: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
}) => (
  <div className="flex flex-col gap-2">
    {back}
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="line-clamp-2 min-w-0 text-2xl leading-tight font-semibold tracking-tight text-balance wrap-anywhere sm:text-[28px]">
          {title}
        </h1>
        {note !== undefined && (
          <div className="min-w-0 text-sm wrap-anywhere text-muted-foreground">{note}</div>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>
      )}
    </div>
    {meta !== undefined && (
      <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1 *:min-w-0">{meta}</div>
    )}
  </div>
);

export const Toolbar = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) => (
  <div
    role="group"
    aria-label={label}
    className="flex flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-2 max-sm:*:w-full"
  >
    {children}
  </div>
);
