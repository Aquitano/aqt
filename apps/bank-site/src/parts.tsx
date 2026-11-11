import { useRef, useState, type ReactNode } from "react";

import { gsap, riseLines, useGSAP, whenMoving } from "./motion";

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const scope = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        const trigger = { trigger: scope.current, start: "top 82%", once: true };
        gsap.from("[data-rule]", {
          scaleX: 0,
          transformOrigin: "left",
          duration: 1.1,
          ease: "power3.inOut",
          scrollTrigger: trigger,
        });
        const heading = scope.current?.querySelector("h2");
        if (heading) riseLines(heading, { scrollTrigger: trigger });
      });
    },
    { scope },
  );

  return (
    <section ref={scope} id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <div data-rule className="bg-rule h-px" />
      <h2 id={`${id}-title`} className="display mt-8 max-w-[26ch] text-[1.5rem] md:text-[2.1rem]">
        {title}
      </h2>
      <div className="mt-10">{children}</div>
    </section>
  );
}

export function Terminal({
  title,
  action,
  children,
}: {
  title: string;
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
      {"\n"}
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
    <button
      type="button"
      onClick={copy}
      className="hover:text-ink cursor-pointer"
      aria-live="polite"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
