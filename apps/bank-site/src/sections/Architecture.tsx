import { useState, type ReactNode } from "react";

import { kindColor, type Kind } from "../brand";
import { Note, Section } from "../ui";

type Domain = "bank" | "attic";
type Source = { name: string; kind: Kind; domain: Domain; path: string };

const sources: Source[] = [
  {
    name: "gmail",
    kind: "mail",
    domain: "bank",
    path: "Gmail is synced by an importer into the bank schema and served under /v1.",
  },
  {
    name: "imap",
    kind: "mail",
    domain: "bank",
    path: "IMAP mail is collected by an importer into the bank schema and served under /v1.",
  },
  {
    name: "whatsapp",
    kind: "chat",
    domain: "bank",
    path: "WhatsApp exports are read by an importer into the bank schema and served under /v1.",
  },
  {
    name: "discord",
    kind: "chat",
    domain: "bank",
    path: "Discord packages are read by an importer into the bank schema and served under /v1.",
  },
  {
    name: "ai chats",
    kind: "ai",
    domain: "bank",
    path: "AI conversations are read by an importer into the bank schema and served under /v1.",
  },
  {
    name: "documents",
    kind: "library",
    domain: "bank",
    path: "Documents are uploaded into the bank schema, their bytes stored once by SHA-256.",
  },
  {
    name: "drives",
    kind: "disks",
    domain: "attic",
    path: "Drives are read by the scanner into the attic schema. The bytes stay on the drive.",
  },
];

function Box({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <span className="border-rule bg-panel border px-2.5 py-1.5">
      {children}
      {sub ? <span className="text-faint block text-[0.68rem]">{sub}</span> : null}
    </span>
  );
}

function Lane({ label, dim, children }: { label: string; dim?: boolean; children: ReactNode }) {
  return (
    <div
      className={`border-dim grid gap-3 border p-4 transition-opacity duration-200 ${dim ? "opacity-35" : ""}`}
    >
      <span className="text-faint">{label}</span>
      {children}
    </div>
  );
}

export function Architecture() {
  const [lit, setLit] = useState<Source | null>(null);
  const off = (domain: Domain) => lit !== null && lit.domain !== domain;

  return (
    <Section
      id="architecture"
      title="How it is built"
      lede="One database, one server, one token file. Each kind of data is a domain with its own Postgres schema and its own routes, so adding watch history never touches mail."
    >
      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <div className="min-w-0 overflow-x-auto">
          <div className="mono text-code grid min-w-[36rem]">
            <Lane label="Sources">
              <div className="flex flex-wrap gap-2" onMouseLeave={() => setLit(null)}>
                {sources.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onMouseEnter={() => setLit(s)}
                    onFocus={() => setLit(s)}
                    onBlur={() => setLit(null)}
                    className={`border-rule bg-panel hover:border-ink focus-visible:border-ink cursor-default border px-2.5 py-1.5 ${kindColor[s.kind]}`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </Lane>
            <pre className="text-faint py-1 pl-10 leading-tight" aria-hidden="true">
              {"│\n▼"}
            </pre>
            <Lane label="One ParadeDB">
              <div className="grid grid-cols-2 gap-3">
                <div
                  className={`border-rule grid content-start gap-2.5 border border-dashed p-3 transition-opacity duration-200 ${off("bank") ? "opacity-35" : ""}`}
                >
                  <span>schema public, bank</span>
                  <div className="flex flex-wrap gap-2">
                    <Box>messages</Box>
                    <Box>threads</Box>
                    <Box>contacts</Box>
                    <Box>library</Box>
                    <Box>text</Box>
                  </div>
                  <Box sub="SHA-256, stored on disk">blobs</Box>
                </div>
                <div
                  className={`border-rule grid content-start gap-2.5 border border-dashed p-3 transition-opacity duration-200 ${off("attic") ? "opacity-35" : ""}`}
                >
                  <span>schema attic, catalogue</span>
                  <div className="flex flex-wrap gap-2">
                    <Box>volumes</Box>
                    <Box>entries</Box>
                    <Box>text</Box>
                    <Box>OCR</Box>
                  </div>
                  <Box sub="BLAKE3, bytes stay on the drive">contents</Box>
                </div>
              </div>
              <span className="border-ink border px-2.5 py-1.5 text-center">
                blob_digests: SHA-256 to BLAKE3, the join between a mail and a drive
              </span>
            </Lane>
            <pre className="text-faint py-1 pl-10 leading-tight" aria-hidden="true">
              {"│\n▼"}
            </pre>
            <Lane label="One server">
              <div className="flex flex-wrap gap-2">
                <span
                  className={`transition-opacity duration-200 ${off("bank") ? "opacity-35" : ""}`}
                >
                  <Box sub="archive and library">/v1</Box>
                </span>
                <span
                  className={`transition-opacity duration-200 ${off("attic") ? "opacity-35" : ""}`}
                >
                  <Box sub="catalogue">/attic/v1</Box>
                </span>
                <Box sub="generated from the handlers">openapi.json</Box>
                <Box sub="read-only, per domain">scoped tokens</Box>
              </div>
            </Lane>
            <pre className="text-faint py-1 pl-10 leading-tight" aria-hidden="true">
              {"│\n▼"}
            </pre>
            <Lane label="Readers">
              <div className="flex flex-wrap gap-2">
                <Box>command line</Box>
                <Box>web UI</Box>
                <Box sub="generated client, MCP">agents</Box>
                <Box sub="cite refs">your notes</Box>
              </div>
            </Lane>
          </div>
          <p className="text-dim mt-4 min-h-[3.2em]" aria-live="polite">
            {lit ? lit.path : "Point at a source to follow it through."}
          </p>
        </div>
        <Note>
          <p>
            <strong className="text-ink font-medium">Domains, not plugins.</strong> A domain is a Go
            package, a schema and a group of routes. It ships in the binary and is reviewed like any
            other code.
          </p>
          <p>
            <strong className="text-ink font-medium">The API document is generated.</strong>{" "}
            Handlers are typed functions, the OpenAPI document is built from them and checked in CI.
            What an agent reads is what the server does.
          </p>
          <p>
            <strong className="text-ink font-medium">A slow domain cannot stop the server.</strong>{" "}
            The catalogue starts in the background and answers 503 until it is ready.
          </p>
        </Note>
      </div>
    </Section>
  );
}
