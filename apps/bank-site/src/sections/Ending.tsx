import { useState, type SubmitEvent } from "react";

import { brand } from "../brand";
import { Code, CopyButton, Prompt, Section, Terminal } from "../parts";

type Sent = "idle" | "sending" | "done" | "failed";

function Waitlist() {
  const [sent, setSent] = useState<Sent>("idle");
  const url = brand.waitlistUrl;

  if (!url) return null;

  const join = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    setSent("sending");
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    setSent(response?.ok ? "done" : "failed");
  };

  return (
    <form onSubmit={join} className="mono text-code flex flex-wrap gap-3">
      <label htmlFor="waitlist-email" className="text-dim w-full">
        Hosted version: not yet. One mail when it opens.
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
        className="btn disabled:opacity-60"
      >
        {sent === "done" ? "You are on the list" : "Join the waitlist"}
      </button>
      {sent === "failed" ? (
        <p className="w-full" role="alert">
          That did not go through. Check your connection and try again.
        </p>
      ) : null}
    </form>
  );
}

const commands = [
  `git clone ${brand.repo}`,
  "cd aqt/apps/bank",
  "docker compose up -d --wait",
  "go build -o bank ./cmd/bank",
  "./bank import mbox ~/mail.mbox",
  './bank search "lease deposit"',
];

const browser = [
  "export BANK_TOKEN=$(./bank token new laptop)",
  "./bank serve &",
  "export BANK_URL=http://127.0.0.1:8480",
  "./bank ui",
];

const agent = ['claude mcp add --scope user bank -- "$PWD/bank" mcp'];

const drives = [
  "go build -o attic.exe ./cmd/attic",
  '$env:DATABASE_URL = "postgres://bank:bank@127.0.0.1:5433/bank?sslmode=disable"',
  ".\\attic.exe scan E:\\",
];

function Commands({ lines, sign }: { lines: string[]; sign?: string }) {
  return lines.map((line) => (
    <span
      key={line}
      className="block pl-[2ch] -indent-[2ch] [overflow-wrap:anywhere] whitespace-pre-wrap"
    >
      <Prompt sign={sign}>{line}</Prompt>
    </span>
  ));
}

export function Run() {
  return (
    <Section
      id="run"
      title="Run it yourself."
      sub="From clone to first search. The binary is still called bank, and there is no hosted version yet."
    >
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <Terminal
          title="bash · needs Docker, Go 1.27 and an mbox export"
          action={<CopyButton text={commands.join("\n")} />}
        >
          <Commands lines={commands} />
        </Terminal>
        <Terminal
          title="bash · then the web UI, at 127.0.0.1:8481"
          action={<CopyButton text={browser.join("\n")} />}
        >
          <Commands lines={browser} />
        </Terminal>
      </div>
      <div className="mt-6 grid gap-x-8 gap-y-6 lg:grid-cols-2 lg:items-start">
        <Terminal
          title="bash · MCP for Claude Code, no server needed"
          className="xl:text-[0.76rem]"
          action={<CopyButton text={agent.join("\n")} />}
        >
          <Commands lines={agent} />
        </Terminal>
        <Terminal
          title="PowerShell · catalogue a drive, on Windows"
          action={<CopyButton text={drives.join("\n")} />}
        >
          <Commands lines={drives} sign="PS>" />
        </Terminal>
      </div>
      <p className="text-dim mt-6 max-w-[56rem] text-[0.97rem] leading-normal">
        Postgres listens on loopback only, so build and run attic on the machine that runs the
        database, in <Code>apps/bank</Code>.
      </p>
      <div id="hosted" className="mt-8 scroll-mt-24 empty:hidden">
        <Waitlist />
      </div>
    </Section>
  );
}

export function Footer() {
  return (
    <footer className="mt-28">
      <p
        role="img"
        aria-label={brand.name}
        className="display -mr-[0.06em] -ml-[0.09em] flex justify-between pt-[0.08em] pb-[0.24em] text-[clamp(4rem,21vw,17rem)] leading-none tracking-normal [text-shadow:0_0_28px_rgb(236_232_220/0.2)]"
      >
        {brand.name
          .toLowerCase()
          .split("")
          .map((letter) => (
            <span key={letter} aria-hidden="true">
              {letter}
            </span>
          ))}
      </p>
      <div className="mono border-rule text-code text-faint mt-6 flex flex-wrap justify-between gap-x-8 gap-y-2 border-t pt-5">
        <span>siglum, n. the mark an editor uses to cite one source</span>
        <span className="flex gap-x-7">
          <a href={`${brand.repo}/blob/main/LICENSE`} className="hover:text-ink">
            AGPL-3.0
          </a>
          <a href={brand.repo} className="hover:text-ink">
            GitHub
          </a>
          <a href={brand.docs} className="hover:text-ink">
            Docs
          </a>
        </span>
      </div>
    </footer>
  );
}
