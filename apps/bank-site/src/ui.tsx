import type { ReactNode } from "react";

export function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-rule border-t pt-10">
      <div className="grid gap-x-12 gap-y-4 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <h2 id={`${id}-title`} className="display text-[1.55rem] md:text-[1.9rem]">
          {title}
        </h2>
        {lede ? <p className="text-dim max-w-[58ch]">{lede}</p> : null}
      </div>
      <div className="mt-10">{children}</div>
    </section>
  );
}

export function Terminal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure className="mono border-rule bg-panel text-code min-w-0 border">
      <figcaption className="border-rule text-faint border-b px-4 py-2">{title}</figcaption>
      <pre className="overflow-x-auto p-4">{children}</pre>
    </figure>
  );
}

export function Prompt({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="text-faint select-none">$ </span>
      {children}
      {"\n"}
    </>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="text-dim grid max-w-[46ch] content-start gap-4">{children}</div>;
}
