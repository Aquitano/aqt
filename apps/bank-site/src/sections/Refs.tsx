import { brand } from "../brand";
import { Prompt, Ref, Section } from "../parts";
import type { RefId } from "../records";

type Line = { rail: string; label: string; value: string; tone?: "drives" | "mail" | "dim" };

const cited: RefId = "a04d77e19c52";

const tree: Line[] = [
  { rail: "├─ ", label: "message", value: "mail, 2024-02-26, me to Property office", tone: "mail" },
  { rail: "├─ ", label: "attachment", value: "lease_signed.pdf, 1.8 MB" },
  { rail: "│  ├─ ", label: "sha-256", value: "91d0c4…e7a2", tone: "dim" },
  { rail: "│  ├─ ", label: "blake3", value: "7c1e5a…b04f", tone: "dim" },
  { rail: "│  └─ ", label: "text", value: "OCR, 4 pages, complete", tone: "dim" },
  { rail: "└─ ", label: "same file", value: "2 other places" },
  { rail: "   ├─ ", label: "archive-2", value: "/scans/2024/lease_signed.pdf", tone: "drives" },
  { rail: "   └─ ", label: "nas", value: "/backup/documents/lease_signed.pdf", tone: "drives" },
];

const tones = { drives: "text-drives", mail: "text-mail", dim: "text-dim" } as const;

const note: [string, RefId][] = [
  ["Signed lease sent to the property office on 26 February.", cited],
  ["Deposit and key handover confirmed the same day.", "3fa91c20b7e4"],
  ["Anna asked about the transfer that morning.", "9be2f0416a3d"],
];

export function Refs() {
  return (
    <Section id="refs" title="What a ref resolves to">
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <figure className="frame border-rule bg-panel min-w-0 border">
          <figcaption className="mono border-rule text-code text-faint border-b px-4 py-2">
            notes/lease.md, written by an agent
          </figcaption>
          <ul className="grid gap-4 p-5 text-[1rem] leading-normal">
            {note.map(([sentence, id]) => (
              <li key={id}>
                {sentence}{" "}
                <Ref
                  id={id}
                  className={`mono text-code whitespace-nowrap ${id === cited ? "bg-ink text-ground px-1" : "ref text-dim"}`}
                />
              </li>
            ))}
          </ul>
        </figure>

        <figure className="frame mono border-rule bg-panel text-code min-w-0 border">
          <figcaption className="border-rule border-b px-4 py-2">
            <Prompt>
              {brand.cmd} ref {cited}
            </Prompt>
          </figcaption>
          <pre className="overflow-x-auto p-5 leading-[1.9]">
            {tree.map((line) => (
              <span key={line.rail + line.label} className="block">
                <span className="text-faint">{line.rail}</span>
                <span className={line.tone === "drives" ? "text-drives" : ""}>
                  {line.label.padEnd(12)}
                </span>
                <span className={line.tone ? tones[line.tone] : ""}>{line.value}</span>
              </span>
            ))}
          </pre>
        </figure>
      </div>
    </Section>
  );
}
