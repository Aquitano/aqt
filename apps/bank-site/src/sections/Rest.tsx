import { useState, type SubmitEvent } from "react";

import { brand } from "../brand";
import { Note, Prompt, Section, Terminal } from "../ui";

const rules = [
  [
    "You run it",
    "One container and one Postgres on a machine you own, reached over your own network. There is no account and no copy in someone else's cloud.",
  ],
  [
    "Bytes are named by their hash",
    "A file attached to forty mails is stored once. The same file on three drives is one content with three locations.",
  ],
  [
    "Imports only add",
    "Nothing is edited in place. A retired record answers 410 and says where it went.",
  ],
  [
    "A token says what it may do",
    "Read-only, one domain, or both. Tokens are stored as hashes and revoked by name.",
  ],
  [
    "Text is part of the record",
    "What a PDF or a scan says is extracted on arrival and indexed with the message it came in.",
  ],
  [
    "Few moving parts",
    "Postgres, Go, files on disk. The database is the search engine and the catalogue. There is nothing else to operate.",
  ],
] as const;

export function Rules() {
  return (
    <Section id="rules" title="Ground rules">
      <dl className="grid gap-x-12 md:grid-cols-2">
        {rules.map(([term, text]) => (
          <div key={term} className="border-rule-soft border-t py-5">
            <dt className="mono text-[0.9rem] font-medium">{term}</dt>
            <dd className="text-dim mt-1.5 max-w-[48ch]">{text}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

type State = "works" | "in review" | "being built" | "later";

const pieces: [string, string, State][] = [
  ["Message archive", "Mail, chats, AI conversations, attachments, contacts, search", "works"],
  ["Library", "Documents, pages, collections, watch history, text and OCR", "works"],
  ["Command line and web UI", "Search, read, import, manage tokens", "works"],
  [
    "One database and server",
    "The drive catalogue in its own schema, served next to the archive",
    "in review",
  ],
  ["Scoped tokens", "Read-only and per-domain access", "in review"],
  ["Timeline and refs", "One feed across domains, one resolver for every ref", "in review"],
  ["Generated API", "49 typed operations, OpenAPI document checked in CI", "in review"],
  ["MCP tools", "Search, refs and the timeline as tools an agent can call", "being built"],
  ["Search by meaning", "Embeddings next to BM25, in the same Postgres", "later"],
  ["Hosted version", "The same software, run for you", "later"],
];

const mark = {
  works: "●",
  "in review": "◐",
  "being built": "◔",
  later: "○",
} satisfies Record<State, string>;

export function Status() {
  return (
    <Section
      id="status"
      title="Where it stands"
      lede="The archive and the library are in daily use. The pieces that join them with the drive catalogue are in review now."
    >
      <div className="min-w-0 overflow-x-auto">
        <table className="mono text-code w-full min-w-[34rem]">
          <tbody>
            {pieces.map(([name, what, state]) => (
              <tr key={name} className="border-rule-soft border-t align-top">
                <td className="py-2.5 pr-6 whitespace-nowrap">{name}</td>
                <td className="text-dim py-2.5 pr-6">{what}</td>
                <td
                  className={`py-2.5 whitespace-nowrap ${state === "works" ? "text-ink" : "text-faint"}`}
                >
                  <span aria-hidden="true">{mark[state]} </span>
                  {state}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function Run() {
  const c = brand.cmd;
  return (
    <Section
      id="run"
      title="Run it yourself"
      lede="A Gmail Takeout is enough to see every piece work: threads, attachment text, search and refs. Add a source when you miss it. Nothing depends on having all of them."
    >
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <Terminal title="First ten minutes">
          <Prompt>git clone {brand.repo}</Prompt>
          <Prompt>cd aqt/apps/bank && docker compose up -d</Prompt>
          <Prompt>{c} token new laptop</Prompt>
          <Prompt>
            {c} token new reader --read-only{"     "}
            <span className="text-faint"># for an agent</span>
          </Prompt>
          <Prompt>{c} import mbox ~/Takeout/mail.mbox</Prompt>
          <span className="text-faint select-none">$ </span>
          {c} search "the thing you could not find"
        </Terminal>
        <Note>
          <p>
            The server speaks plain HTTP on purpose. Bind it to a private network such as a tailnet
            and let that carry the encryption.
          </p>
          <p>
            In the repository the command is still called{" "}
            <span className="mono text-code">bank</span>. The rename to{" "}
            <span className="mono text-code">{c}</span> lands with the first tagged release.
          </p>
        </Note>
      </div>
    </Section>
  );
}

type Sent = "idle" | "sending" | "done" | "failed";

export function Hosted() {
  const [sent, setSent] = useState<Sent>("idle");

  const join = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!brand.waitlistUrl) return;
    const email = new FormData(event.currentTarget).get("email");
    setSent("sending");
    const response = await fetch(brand.waitlistUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    setSent(response?.ok ? "done" : "failed");
  };

  return (
    <Section
      id="hosted"
      title="Hosted, later"
      lede="A hosted version will run the same open source code for people who do not want to operate a server. It does not exist yet, and it will not launch before export and deletion work as well as import does."
    >
      {brand.waitlistUrl ? (
        <form onSubmit={join} className="mono flex max-w-xl flex-wrap gap-3 text-[0.85rem]">
          <label htmlFor="waitlist-email" className="sr-only">
            Email address
          </label>
          <input
            id="waitlist-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className="border-rule bg-panel placeholder:text-faint min-w-0 flex-1 border px-4 py-3"
          />
          <button
            type="submit"
            disabled={sent === "sending" || sent === "done"}
            className="border-ink hover:bg-ink hover:text-ground cursor-pointer border px-5 py-3 disabled:cursor-default disabled:opacity-60"
          >
            {sent === "done" ? "You are on the list" : "Join the waitlist"}
          </button>
          <p className="text-faint w-full" aria-live="polite">
            {sent === "failed"
              ? "That did not go through. Check your connection and try again."
              : "One mail when it opens. Nothing else."}
          </p>
        </form>
      ) : (
        <p className="text-dim max-w-[58ch]">
          Until there is a list to join,{" "}
          <a href={brand.repo} className="text-ink decoration-faint underline underline-offset-4">
            watch releases on GitHub
          </a>{" "}
          to hear when it opens.
        </p>
      )}
    </Section>
  );
}
