import type { ReactNode } from "react";

/**
 * A box in a diagram: a name in mono, an optional caption under it. A `compact` node puts the
 * caption beside the name below `lg`, for lists that would otherwise stack too tall.
 */
export function Node({
  children,
  sub,
  dashed = false,
  strong = false,
  compact = false,
  className = "",
}: {
  children: ReactNode;
  sub?: ReactNode;
  dashed?: boolean;
  strong?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`bg-panel min-w-0 border px-3 ${compact ? "flex items-baseline justify-between gap-3 py-1.5 lg:block lg:py-2" : "block py-2"} ${strong ? "border-ink glow-box" : "border-faint/55"} ${dashed ? "border-dashed" : ""} ${className}`}
    >
      <span className={`block font-medium [overflow-wrap:anywhere] ${strong ? "glow" : ""}`}>
        {children}
      </span>
      {sub ? (
        <span
          className={`text-faint block text-[0.76rem] ${compact ? "max-lg:text-right max-lg:whitespace-nowrap" : "[overflow-wrap:anywhere]"}`}
        >
          {sub}
        </span>
      ) : null}
    </span>
  );
}

const label = "text-faint text-[0.76rem]";

/** An arrow pointing right, with its label riding on the line. */
export function Across({
  label: text,
  open = false,
  className = "",
}: {
  label?: string;
  open?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`relative flex min-w-[4.75rem] flex-1 items-center self-center ${className}`}
    >
      <span className="glow-line flex w-full items-center">
        <span className="border-dim w-full border-t" />
        {open ? null : (
          <span className="border-l-dim border-y-[3.5px] border-l-[6px] border-y-transparent" />
        )}
      </span>
      {text ? (
        <span
          className={`${label} absolute inset-x-0 -top-[1.15rem] text-center whitespace-nowrap`}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** A vertical arrow that takes up whatever height its column has spare, with its label beside it. */
function Vertical({
  label: text,
  up = false,
  short = false,
  className = "",
}: {
  label?: string;
  up?: boolean;
  short?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex items-stretch gap-3 pl-5 ${short ? "h-4" : "min-h-7 flex-1"} ${className}`}
    >
      <span className={`glow-line flex items-center ${up ? "flex-col-reverse" : "flex-col"}`}>
        <span className="border-dim min-h-2 flex-1 border-l" />
        <span
          className={`border-x-[3.5px] border-x-transparent ${up ? "border-b-dim border-b-[6px]" : "border-t-dim border-t-[6px]"}`}
        />
      </span>
      {text ? <span className={`${label} self-center`}>{text}</span> : null}
    </span>
  );
}

export function Down(props: { label?: string; short?: boolean; className?: string }) {
  return <Vertical {...props} />;
}

export function Up(props: { label?: string; className?: string }) {
  return <Vertical up {...props} />;
}

const flowAt = {
  lg: ["lg:hidden", "max-lg:hidden"],
  xl: ["xl:hidden", "max-xl:hidden"],
} as const;

/** An arrow that runs down on narrow screens and across from the `at` breakpoint up. */
export function Flow({ label: text, at = "lg" }: { label?: string; at?: keyof typeof flowAt }) {
  const [narrow, wide] = flowAt[at];
  return (
    <>
      <Down label={text} className={narrow} />
      <Across label={text} className={wide} />
    </>
  );
}

/** Where an arrow splits to a column of boxes: one prong to the first, one to the last. */
export function Fork({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`glow-line relative w-4 shrink-0 self-stretch ${className}`}
    >
      <span className="border-dim absolute inset-y-0 right-1.5 left-0 border-y border-l" />
      <span className="border-l-dim absolute top-0 right-0 -translate-y-1/2 border-y-[3.5px] border-l-[6px] border-y-transparent" />
      <span className="border-l-dim absolute right-0 bottom-0 translate-y-1/2 border-y-[3.5px] border-l-[6px] border-y-transparent" />
    </span>
  );
}
