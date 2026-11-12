import { useState, useSyncExternalStore, type ReactNode } from "react";

import { record, type RefId } from "./records";

/** A section's heading: the claim in display type, one plain sentence under it. */
export function Heading({ id, title, sub }: { id: string; title: string; sub?: string }) {
  return (
    <div className="grid max-w-[56rem] gap-2.5">
      <h2 id={id} className="display text-[1.5rem] md:text-[1.9rem]">
        {title}
      </h2>
      {sub ? <p className="text-dim text-[1.1rem] leading-normal text-pretty">{sub}</p> : null}
    </div>
  );
}

/** The nav is 64px tall with its rule; one less puts a section's top rule on the nav's. */
export const underNav = "scroll-mt-[63px]";

export function Section({
  id,
  title,
  sub,
  children,
}: {
  id: string;
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`border-rule border-t pt-8 ${underNav}`}
    >
      <Heading id={`${id}-title`} title={title} sub={sub} />
      <div className="mt-10">{children}</div>
    </section>
  );
}

const columns = {
  2: "at-lg lg:grid-cols-2",
  3: "at-lg lg:grid-cols-3",
  // Its middle cell holds a code block, which needs the width three columns only have from `xl`.
  "wide-middle": "at-xl xl:grid-cols-[minmax(0,10fr)_minmax(0,17fr)_minmax(0,12fr)]",
} as const;

/** A row of small explanations under a section's main visual, each with its own diagram. */
export function Cells({
  cols = 2,
  children,
}: {
  cols?: keyof typeof columns;
  children: ReactNode;
}) {
  return <div className={`cells ${columns[cols]}`}>{children}</div>;
}

const wide = matchMedia("(min-width: 64rem)");
const watchWide = (changed: () => void) => {
  wide.addEventListener("change", changed);
  return () => wide.removeEventListener("change", changed);
};

/** True from the `lg` breakpoint up. */
export const useWide = () => useSyncExternalStore(watchWide, () => wide.matches);

/**
 * One explanation with its diagram. A `fold` cell is supporting detail: below `lg`, where cells
 * stack into a long column, it shows only its title until opened.
 */
export function Cell({
  title,
  text,
  fold = false,
  children,
}: {
  title: string;
  text: ReactNode;
  fold?: boolean;
  children: ReactNode;
}) {
  const isWide = useWide();
  const [opened, setOpened] = useState(false);
  const folds = fold && !isWide;
  const shown = !folds || opened;

  return (
    <div className="cell">
      <h3 className="mono text-[0.9rem] font-medium">
        {folds ? (
          <button
            type="button"
            aria-expanded={opened}
            onClick={() => setOpened(!opened)}
            className="-my-3 flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 text-left"
          >
            {title}
            <span className="text-faint font-normal">{opened ? "hide" : "show"}</span>
          </button>
        ) : (
          title
        )}
      </h3>
      {shown ? (
        <>
          <p className="text-dim text-[0.97rem] leading-normal text-pretty">{text}</p>
          <div className="mono text-code mt-3 flex max-w-[34rem] min-w-0 flex-col gap-1">
            {children}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * A ref the visitor can point at. RefTip shows what it names; screen readers get it inline,
 * unless the row around the ref already says it (`bare`).
 */
export function Ref({
  id,
  bare = false,
  className = "ref",
}: {
  id: RefId;
  bare?: boolean;
  className?: string;
}) {
  const entry = record(id);
  return (
    <span data-ref={id} tabIndex={0} className={`cursor-help ${className}`}>
      {id}
      {bare ? null : (
        <span className="sr-only select-none">{`, ${entry.from}, ${entry.date}: ${entry.text}`}</span>
      )}
    </span>
  );
}

export function Terminal({
  title,
  action,
  className = "",
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className="frame mono border-rule bg-panel text-code flex min-w-0 flex-col border">
      <figcaption className="border-rule text-faint flex items-baseline justify-between gap-4 border-b px-4 py-3 sm:px-6">
        <span>{title}</span>
        {action}
      </figcaption>
      <pre className={`flex-1 overflow-x-auto p-4 sm:px-6 ${className}`}>{children}</pre>
    </figure>
  );
}

/** A command, path or variable named inside a sentence. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="mono text-ink text-[0.84em]">{children}</code>;
}

export function Prompt({ sign = "$", children }: { sign?: string; children: ReactNode }) {
  return (
    <>
      <span className="text-faint select-none">{sign} </span>
      {children}
    </>
  );
}

type Copy = "idle" | "copied" | "failed";

const copyLabel = {
  idle: "Copy",
  copied: "Copied",
  failed: "Couldn't copy, select it instead",
} satisfies Record<Copy, string>;

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<Copy>("idle");

  const copy = async () => {
    const ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), ok ? 1600 : 4000);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="hover:text-ink -my-3 min-h-11 min-w-11 cursor-pointer text-right"
    >
      <span role="status">{copyLabel[state]}</span>
    </button>
  );
}
