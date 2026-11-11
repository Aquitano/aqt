import { useState, type SubmitEvent } from "react";

import { brand } from "../brand";
import { CopyButton, Prompt, Section, Terminal } from "../parts";

type Sent = "idle" | "sending" | "done" | "failed";

function Waitlist() {
  const [sent, setSent] = useState<Sent>("idle");
  const url = brand.waitlistUrl;

  if (!url) {
    return (
      <p className="mono text-code text-dim">
        Hosted version: not yet.{" "}
        <a href={brand.repo} className="text-ink decoration-faint underline underline-offset-4">
          Watch releases
        </a>{" "}
        to hear when it opens.
      </p>
    );
  }

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
  `git clone ${brand.repo} && cd aqt/apps/bank`,
  "docker compose up -d",
  "go build -o bank ./cmd/bank",
  "./bank import mbox ~/Takeout/mail.mbox",
  './bank search "the thing you could not find"',
];

export function Run() {
  return (
    <Section id="run" title="Run it yourself">
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
        <Terminal title="needs Docker and Go" action={<CopyButton text={commands.join("\n")} />}>
          {commands.map((command) => (
            <span key={command} className="block">
              <Prompt>{command}</Prompt>
            </span>
          ))}
        </Terminal>
        <div id="hosted" className="grid scroll-mt-24 gap-5">
          <p className="mono text-code text-dim">
            The binary is called <span className="text-ink">bank</span> until the first tagged
            release.
          </p>
          <Waitlist />
        </div>
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
        className="display flex justify-between overflow-hidden pb-[0.2em] text-[clamp(4rem,21vw,17rem)] leading-[0.82]"
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
          <a href={brand.repo} className="hover:text-ink">
            GitHub
          </a>
          <a href={brand.docs} className="hover:text-ink">
            Documentation
          </a>
        </span>
      </div>
    </footer>
  );
}
