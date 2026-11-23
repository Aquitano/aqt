import type { ReactNode } from "react";

import { brand, kindColor } from "../brand";
import { Down, Node } from "../diagram";
import { Cell, Cells, CopyButton, Ref, Section, Terminal } from "../parts";
import { record, type RefId } from "../records";

const found: RefId[] = ["bank:5b1e09d3c7f2", "bank:3fa91c20b7e4", "bank:77f0c1a2d458"];

const tools = ["search", "ref", "timeline", "message", "thread"] as const;

const targets = ["archive", "drives"] as const;
type Target = (typeof targets)[number];

const tokens: { name: string; flags: string[]; writes: boolean; reach: Target[] }[] = [
  { name: "laptop", flags: ["full access"], writes: true, reach: ["archive", "drives"] },
  { name: "agent", flags: ["--read-only"], writes: false, reach: ["archive", "drives"] },
  { name: "imap", flags: ["--domain bank"], writes: true, reach: ["archive"] },
  { name: "file-search", flags: ["--domain attic"], writes: true, reach: ["drives"] },
];

const mcpJson = `{
  "mcpServers": {
    "${brand.bin}": {
      "command": "${brand.bin}",
      "args": ["mcp"],
      "env": {
        "BANK_URL": "\${BANK_URL:-}",
        "BANK_TOKEN": "\${BANK_TOKEN:-}"
      }
    }
  }
}`;

const targetColor = { archive: "text-ink", drives: "text-drives" } satisfies Record<Target, string>;

/**
 * One line per thing a token may reach. The box is 100 by 100 and stretched to fit between the
 * columns. The catalogue's API only reads, so no line into drives is ever a writing one.
 */
const grants = tokens.flatMap((token, i) =>
  token.reach.map((target) => {
    const from = ((i + 0.5) / tokens.length) * 100;
    const to = ((targets.indexOf(target) + 0.5) / targets.length) * 100;
    return {
      key: `${token.name}-${target}`,
      d: `M0,${from} C55,${from} 45,${to} 100,${to}`,
      writes: token.writes && target === "archive",
    };
  }),
);

function Grants() {
  return (
    <>
      <div className="grid flex-1 grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_5.4rem]">
        <ul className="grid auto-rows-fr">
          {tokens.map((token) => (
            <li key={token.name} className="py-1">
              <Node
                className="h-full"
                sub={token.flags.map((flag) => (
                  <span key={flag} className="block whitespace-nowrap">
                    {flag}
                  </span>
                ))}
              >
                {token.name}
              </Node>
            </li>
          ))}
        </ul>
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="glow-line h-full w-full"
        >
          {grants.map((line) => (
            <path
              key={line.key}
              d={line.d}
              fill="none"
              stroke="var(--color-dim)"
              strokeWidth="1"
              strokeDasharray={line.writes ? undefined : "3 4"}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <ul className="grid auto-rows-fr">
          {targets.map((target) => (
            <li key={target} className="flex items-center">
              <Node strong className="w-full text-center">
                <span className={targetColor[target]}>{target}</span>
              </Node>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-faint mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[0.76rem]">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="border-dim w-6 border-t" /> reads and writes
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="border-dim w-6 border-t border-dashed" /> reads only
        </span>
      </p>
    </>
  );
}

function Call({ tool, args, result }: { tool: string; args: ReactNode; result: string }) {
  return (
    <p className="mono text-code flex flex-wrap items-baseline gap-x-3">
      <span className="text-faint select-none">tool</span>
      <span>{tool}</span>
      <span className="text-dim">{args}</span>
      <span className="text-faint">{result}</span>
    </p>
  );
}

function Turn({ who, children }: { who: string; children: ReactNode }) {
  return (
    <p className="grid gap-x-3 sm:grid-cols-[2.6rem_minmax(0,1fr)]">
      <span className="mono text-code text-faint pt-[0.2rem]">{who}</span>
      <span className="text-[1rem] leading-normal">{children}</span>
    </p>
  );
}

const cite = "mono text-code ref text-dim whitespace-nowrap";

export function Access() {
  return (
    <Section
      id="access"
      title="Agents read it through five tools."
      sub="They search the archive, open records and cite what they find by ref."
    >
      <figure className="frame border-rule bg-panel border">
        <figcaption className="mono border-rule text-code text-faint flex flex-wrap items-baseline justify-between gap-x-6 border-b px-4 py-3 sm:px-6">
          <span>an agent session over MCP</span>
          <span className="whitespace-nowrap">sample data</span>
        </figcaption>
        <div className="grid gap-4 px-4 py-5 sm:px-6">
          <Turn who="you">When is the key handover?</Turn>
          <div className="grid gap-2 sm:pl-[3.35rem]">
            <Call tool="search" args={'"key handover"'} result="3 results" />
            <ul className="mono text-code border-rule-soft grid gap-1 border-l pl-4">
              {found.map((id) => {
                const row = record(id);
                return (
                  <li
                    key={id}
                    className="grid grid-cols-[3.2rem_minmax(0,1fr)] gap-x-3 md:grid-cols-[3.2rem_10rem_minmax(0,1fr)]"
                  >
                    <span className={kindColor[row.kind]}>{row.kind}</span>
                    <span>
                      <Ref bare id={id} />
                    </span>
                    <span className="text-dim col-start-2 md:col-start-auto">
                      {row.from}: {row.text}
                    </span>
                  </li>
                );
              })}
            </ul>
            <Call
              tool="message"
              args={<Ref bare id="bank:5b1e09d3c7f2" className="" />}
              result="1 message"
            />
            <p className="mono text-code border-rule-soft text-dim border-l pl-4">
              “…the handover moves to Thursday 29 February, same time.”
            </p>
          </div>
          <Turn who="agent">
            Thursday, 29 February. The property office moved it (
            <Ref id="bank:5b1e09d3c7f2" className={cite} />
            ), and Anna acknowledged it (<Ref id="bank:77f0c1a2d458" className={cite} />
            ).
          </Turn>
        </div>
      </figure>

      <Cells cols="wide-middle">
        <Cell
          title="All read-only"
          text="Nothing an agent calls can import, edit or delete. A search answer also says what it left out, such as files on drives when a date filter applies."
        >
          <span className="flex flex-col gap-1">
            <Node sub="Claude Code, or any MCP client">agent</Node>
            <Down label="stdio" />
            <Node strong>{brand.cmd} mcp</Node>
            <Down label="five tools" />
            <span className="grid grid-cols-3 gap-1.5 sm:flex sm:flex-wrap">
              {tools.map((tool) => (
                <span key={tool} className="border-faint/55 bg-panel border px-2 py-1">
                  {tool}
                </span>
              ))}
            </span>
          </span>
        </Cell>

        <Cell
          title="One entry in .mcp.json"
          text={
            <>
              {brand.name}'s binary is still called {brand.bin}. Put it on your PATH or give its
              full path in <code className="mono text-ink text-[0.84em]">command</code>. Without{" "}
              <code className="mono text-ink text-[0.84em]">BANK_URL</code> the tools connect
              directly to Postgres. With it, they use the HTTP server and{" "}
              <code className="mono text-ink text-[0.84em]">BANK_TOKEN</code>.
            </>
          }
        >
          <Terminal
            title=".mcp.json, for Claude Code"
            className="max-sm:p-3 max-sm:text-[0.66rem]"
            action={<CopyButton text={mcpJson} />}
          >
            {mcpJson}
          </Terminal>
        </Cell>

        <Cell
          title="A token per client"
          text="A token can be read-only, and it can be limited to the archive or to the drive catalogue. The catalogue's API only reads, so no token can write to it."
        >
          <Grants />
        </Cell>
      </Cells>
    </Section>
  );
}
