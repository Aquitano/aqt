import { useRef } from "react";

import { brand } from "../brand";
import { gsap, useGSAP, whenMoving } from "../motion";
import { Section, Terminal } from "../parts";

const c = brand.cmd;

const columns = ["read archive", "write archive", "read drives", "write drives"] as const;

const tokens: { flags: string; name: string; may: [boolean, boolean, boolean, boolean] }[] = [
  { name: "laptop", flags: "", may: [true, true, true, true] },
  { name: "agent", flags: "--read-only", may: [true, false, true, false] },
  { name: "notes", flags: "--read-only --domain bank", may: [true, false, false, false] },
  { name: "scanner", flags: "--domain attic", may: [false, false, true, true] },
];

const tools = ["search", "ref", "timeline", "message", "thread"];

export function Access() {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      whenMoving(() => {
        gsap
          .timeline({ scrollTrigger: { trigger: scope.current, start: "top 75%", once: true } })
          .from("[data-token]", { opacity: 0, x: -8, duration: 0.35, stagger: 0.12 })
          .from(
            "[data-cell]",
            {
              scale: 0,
              duration: 0.3,
              ease: "back.out(2.5)",
              stagger: { each: 0.04, grid: [4, 4], from: "start" },
            },
            "<0.1",
          )
          .from("[data-tool]", { opacity: 0, y: 6, duration: 0.3, stagger: 0.08 }, "-=0.3");
      });
    },
    { scope },
  );

  return (
    <Section id="access" title="Hand an agent exactly this much">
      <div ref={scope} className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 overflow-x-auto">
          <table className="mono text-code w-full min-w-[36rem]">
            <thead>
              <tr className="text-faint text-left">
                <th className="pr-4 pb-3 font-normal">{c} token new</th>
                {columns.map((col) => (
                  <th key={col} className="w-[5.5rem] pb-3 text-center font-normal">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.name} className="border-rule-soft border-t">
                  <td data-token className="py-3 pr-4 whitespace-nowrap">
                    {t.name} <span className="text-dim">{t.flags}</span>
                  </td>
                  {t.may.map((yes, i) => (
                    <td key={columns[i]} className="py-3">
                      <span
                        data-cell
                        role="img"
                        aria-label={yes ? "allowed" : "refused"}
                        className={`mx-auto block size-3.5 ${yes ? "bg-ink" : "border-dim border"}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Terminal title=".mcp.json">
          {`{
  "mcpServers": {
    "${c}": {
      "command": "${c}",
      "args": ["mcp"]
    }
  }
}

`}
          <span className="text-faint">tools </span>
          {tools.map((tool) => (
            <span key={tool} data-tool className="inline-block pl-[1ch]">
              {tool}
            </span>
          ))}
        </Terminal>
      </div>
    </Section>
  );
}
