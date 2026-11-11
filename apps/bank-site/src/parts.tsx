import type { ReactNode } from "react";

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
    <section id={id} aria-labelledby={`${id}-title`} className="border-rule border-t pt-8">
      <h2 id={`${id}-title`} className="display max-w-[26ch] text-[1.5rem] md:text-[2.1rem]">
        {title}
      </h2>
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
