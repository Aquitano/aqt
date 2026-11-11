import { useRef, useState, type SubmitEvent } from "react";

import { brand } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { CopyButton, Prompt, Section, Terminal } from "../parts";

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
  works: "bg-ink text-ground border border-ink",
  "in review": "border border-ink",
  later: "border border-dashed border-dim text-dim",
} satisfies Record<State, string>;

const legend: [State, string][] = [
  ["works", "in daily use"],
  ["in review", "written and shown on this page, in pull requests"],
  ["later", "not started"],
];

export function Status() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap.from("[data-piece]", {
          opacity: 0,
          y: 10,
          duration: 0.35,
          stagger: 0.045,
          ease: "power2.out",
          scrollTrigger: { trigger: scope.current, start: "top 80%", once: true },
        });
      });
    },
    { scope },
  );

  return (
    <Section id="status" title="Where it stands">
      <div ref={scope}>
        <ul className="mono text-code flex flex-wrap gap-2">
          {pieces.map(([name, state]) => (
            <li key={name} data-piece className={`px-3 py-2 ${cell[state]}`}>
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
      </div>
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

export function Run() {
  const commands = [
    `git clone ${brand.repo} && cd aqt/apps/bank`,
    "docker compose up -d",
    "go build -o bank ./cmd/bank",
    "./bank import mbox ~/Takeout/mail.mbox",
    './bank search "the thing you could not find"',
  ];

  return (
    <Section id="run" title="Run it yourself">
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
        <Terminal
          title="A Gmail Takeout is enough to start"
          action={<CopyButton text={commands.join("\n")} />}
        >
          {commands.map((command) => (
            <Prompt key={command}>{command}</Prompt>
          ))}
        </Terminal>
        <div id="hosted" className="grid scroll-mt-24 gap-5">
          <p className="mono text-code text-dim">
            The binary is called <span className="text-ink">bank</span> until the first tagged
            release. Elsewhere on this page it already goes by {brand.cmd}.
          </p>
          <Waitlist />
        </div>
      </div>
    </Section>
  );
}

export function Footer() {
  const scope = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap.from("[data-letter]", {
          yPercent: 105,
          duration: 0.9,
          stagger: 0.06,
          ease: "power4.out",
          scrollTrigger: { trigger: scope.current, start: "top 92%", once: true },
        });
      });
    },
    { scope },
  );

  return (
    <footer ref={scope} className="mt-28">
      <p
        role="img"
        aria-label={brand.name}
        className="display flex justify-between overflow-hidden pb-[0.2em] text-[clamp(4rem,21vw,17rem)] leading-[0.82]"
      >
        {brand.name
          .toLowerCase()
          .split("")
          .map((letter) => (
            <span key={letter} data-letter aria-hidden="true" className="inline-block">
              {letter}
            </span>
          ))}
      </p>
      <div className="mono border-rule text-code text-faint mt-6 flex flex-wrap justify-between gap-x-8 gap-y-2 border-t pt-5">
        <span>The mark that names a source.</span>
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
