import { useState, type SubmitEvent } from "react";

import { brand } from "../brand";
import { Prompt, Section, Terminal } from "../parts";

type State = "works" | "in review" | "later";

const pieces: [string, State][] = [
  ["message archive", "works"],
  ["library and watch history", "works"],
  ["text and OCR", "works"],
  ["command line", "works"],
  ["web UI", "works"],
  ["drive catalogue in the same database", "in review"],
  ["scoped tokens", "in review"],
  ["timeline", "in review"],
  ["refs across domains", "in review"],
  ["generated API, 49 operations", "in review"],
  ["MCP tools", "in review"],
  ["search by meaning", "later"],
  ["hosted version", "later"],
];

const cell = {
  works: "bg-ink text-ground",
  "in review": "border border-ink",
  later: "border border-dashed border-rule text-faint",
} satisfies Record<State, string>;

const legend: [State, string][] = [
  ["works", "in daily use"],
  ["in review", "written, in pull requests"],
  ["later", "not started"],
];

export function Status() {
  return (
    <Section id="status" title="Where it stands">
      <ul className="mono text-code flex flex-wrap gap-2">
        {pieces.map(([name, state]) => (
          <li key={name} className={`px-3 py-2 ${cell[state]}`}>
            {name}
          </li>
        ))}
      </ul>
      <ul className="mono text-code text-dim mt-6 flex flex-wrap gap-x-8 gap-y-2">
        {legend.map(([state, meaning]) => (
          <li key={state} className="flex items-center gap-2.5">
            <span aria-hidden="true" className={`block size-3.5 ${cell[state]}`} />
            {meaning}
          </li>
        ))}
      </ul>
    </Section>
  );
}

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
        className="border-ink hover:bg-ink hover:text-ground cursor-pointer border px-5 py-3 disabled:cursor-default disabled:opacity-60"
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

export function Run() {
  const c = brand.cmd;
  return (
    <Section id="run" title="Run it yourself">
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
        <Terminal title="A Gmail Takeout is enough to start">
          <Prompt>git clone {brand.repo}</Prompt>
          <Prompt>cd aqt/apps/bank && docker compose up -d</Prompt>
          <Prompt>{c} token new laptop</Prompt>
          <Prompt>{c} import mbox ~/Takeout/mail.mbox</Prompt>
          <span className="text-faint select-none">$ </span>
          {c} search "the thing you could not find"
        </Terminal>
        <div id="hosted" className="grid gap-5">
          <p className="mono text-code text-dim">
            The command is still <span className="text-ink">bank</span> in the repository until the
            first tagged release.
          </p>
          <Waitlist />
        </div>
      </div>
    </Section>
  );
}
