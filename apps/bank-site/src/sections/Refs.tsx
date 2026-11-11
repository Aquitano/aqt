import { brand } from "../brand";
import { Section } from "../parts";

type Line = { rail: string; label: string; value: string; tone?: "disks" | "mail" | "faint" };

const tree: Line[] = [
  { rail: "├─ ", label: "message", value: "mail, 2024-02-27, me to Property office", tone: "mail" },
  { rail: "├─ ", label: "attachment", value: "lease_signed.pdf, 1.8 MB" },
  { rail: "│  ├─ ", label: "sha-256", value: "91d0c4…e7a2", tone: "faint" },
  { rail: "│  ├─ ", label: "blake3", value: "7c1e5a…b04f", tone: "faint" },
  { rail: "│  └─ ", label: "text", value: "OCR, 4 pages, complete", tone: "faint" },
  { rail: "└─ ", label: "same bytes", value: "2 other places" },
  { rail: "   ├─ ", label: "archive-2", value: "/scans/2024/lease_signed.pdf", tone: "disks" },
  { rail: "   └─ ", label: "nas", value: "/backup/documents/lease_signed.pdf", tone: "disks" },
];

const tones = { disks: "text-disks", mail: "text-mail", faint: "text-dim" } as const;

export function Refs() {
  return (
    <Section id="refs" title="Every record has a ref, and a ref resolves to everything">
      <div className="mono grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
        <div className="grid gap-4">
          <p className="display text-[1.35rem] break-all sm:text-[1.9rem]">
            <span className="text-faint">{brand.cmd}:</span>a04d77e19c52
          </p>
          <ul className="text-code text-dim grid gap-1">
            <li>derived from the record, not from a row number</li>
            <li>survives a rebuild of the database</li>
            <li>answers 410 with a forwarding note when retired</li>
          </ul>
        </div>
        <pre className="border-rule bg-panel text-code overflow-x-auto border p-5 leading-[1.9]">
          <span className="ref">a04d77e19c52</span>
          {"\n"}
          {tree.map((line) => (
            <span key={line.rail + line.label}>
              <span className="text-faint">{line.rail}</span>
              <span className={line.tone === "disks" ? "text-disks" : ""}>
                {line.label.padEnd(12)}
              </span>
              <span className={line.tone ? tones[line.tone] : ""}>{line.value}</span>
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
    </Section>
  );
}
