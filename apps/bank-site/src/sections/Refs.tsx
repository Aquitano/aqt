import { useRef } from "react";

import { brand } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Section } from "../parts";

type Line = { rail: string; label: string; value: string; tone?: "drives" | "mail" | "dim" };

const ref = "a04d77e19c52";

const tree: Line[] = [
  { rail: "├─ ", label: "message", value: "mail, 2024-02-26, me to Property office", tone: "mail" },
  { rail: "├─ ", label: "attachment", value: "lease_signed.pdf, 1.8 MB" },
  { rail: "│  ├─ ", label: "sha-256", value: "91d0c4…e7a2", tone: "dim" },
  { rail: "│  ├─ ", label: "blake3", value: "7c1e5a…b04f", tone: "dim" },
  { rail: "│  └─ ", label: "text", value: "OCR, 4 pages, complete", tone: "dim" },
  { rail: "└─ ", label: "same bytes", value: "2 other places" },
  { rail: "   ├─ ", label: "archive-2", value: "/scans/2024/lease_signed.pdf", tone: "drives" },
  { rail: "   └─ ", label: "nas", value: "/backup/documents/lease_signed.pdf", tone: "drives" },
];

const tones = { drives: "text-drives", mail: "text-mail", dim: "text-dim" } as const;

const facts = [
  "derived from the record, not from a row number",
  "survives a rebuild of the database",
  "answers 410 with a forwarding note when retired",
];

export function Refs() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap
          .timeline({ scrollTrigger: { trigger: scope.current, start: "top 72%", once: true } })
          .to("[data-hash]", {
            duration: 1.1,
            scrambleText: { text: ref, chars: "0123456789abcdef", speed: 0.5 },
            ease: "none",
          })
          .from("[data-fact]", { opacity: 0, x: -8, duration: 0.35, stagger: 0.1 }, "-=0.5")
          .from("[data-root]", { opacity: 0, duration: 0.2 }, "-=0.4")
          .from("[data-branch]", { opacity: 0, x: -6, duration: 0.25, stagger: 0.09 }, "-=0.1");
      });
    },
    { scope },
  );

  return (
    <Section id="refs" title="Every record has a ref, and a ref resolves to everything">
      <div
        ref={scope}
        className="mono grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center"
      >
        <div className="grid gap-5">
          <p className="display text-[1.35rem] break-all sm:text-[1.9rem]">
            <span className="text-faint">{brand.cmd}:</span>
            <span data-hash>{ref}</span>
          </p>
          <ul className="text-code text-dim grid gap-1.5">
            {facts.map((fact) => (
              <li key={fact} data-fact>
                {fact}
              </li>
            ))}
          </ul>
        </div>
        <pre className="frame border-rule bg-panel text-code overflow-x-auto border p-5 leading-[1.9]">
          <span data-root className="ref">
            {ref}
          </span>
          {"\n"}
          {tree.map((line) => (
            <span key={line.rail + line.label} data-branch className="block">
              <span className="text-faint">{line.rail}</span>
              <span className={line.tone === "drives" ? "text-drives" : ""}>
                {line.label.padEnd(12)}
              </span>
              <span className={line.tone ? tones[line.tone] : ""}>{line.value}</span>
            </span>
          ))}
        </pre>
      </div>
    </Section>
  );
}
