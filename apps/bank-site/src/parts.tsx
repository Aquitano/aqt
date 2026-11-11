import { useState, type ReactNode } from "react";

import type { RefId } from "./records";

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="border-rule scroll-mt-20 border-t pt-8"
    >
      <h2 id={`${id}-title`} className="display text-[1.5rem] md:text-[1.9rem]">
        {title}
      </h2>
      <div className="mt-10">{children}</div>
    </section>
  );
}

/** A ref the visitor can point at. RefTip shows what it names. */
export function Ref({ id, className = "ref" }: { id: RefId; className?: string }) {
  return (
    <span data-ref={id} tabIndex={0} className={`cursor-help ${className}`}>
      {id}
    </span>
  );
}

export function Terminal({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="frame mono border-rule bg-panel text-code min-w-0 border">
      <figcaption className="border-rule text-faint flex items-baseline justify-between gap-4 border-b px-4 py-2">
        <span>{title}</span>
        {action}
      </figcaption>
      <pre className="overflow-x-auto p-4">{children}</pre>
    </figure>
  );
}

export function Prompt({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="text-faint select-none">$ </span>
      {children}
    </>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button type="button" onClick={copy} className="hover:text-ink cursor-pointer">
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
