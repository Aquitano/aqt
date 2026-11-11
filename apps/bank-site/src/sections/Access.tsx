import { brand } from "../brand";
import { Section, Terminal } from "../parts";

const c = brand.cmd;

const columns = ["read bank", "write bank", "read attic", "write attic"] as const;

const tokens: { flags: string; name: string; may: [boolean, boolean, boolean, boolean] }[] = [
  { name: "laptop", flags: "", may: [true, true, true, true] },
  { name: "agent", flags: "--read-only", may: [true, false, true, false] },
  { name: "notes", flags: "--read-only --domain bank", may: [true, false, false, false] },
  { name: "scanner", flags: "--domain attic", may: [false, false, true, true] },
];

export function Access() {
  return (
    <Section id="access" title="What a token may do">
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 max-lg:overflow-x-auto">
          <table className="mono text-code w-full min-w-[34rem]">
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
                  <td className="py-3 pr-4 whitespace-nowrap">
                    {t.name} <span className="text-dim">{t.flags}</span>
                  </td>
                  {t.may.map((yes, i) => (
                    <td key={columns[i]} className="py-3">
                      <span
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
          search ref timeline message thread
        </Terminal>
      </div>
    </Section>
  );
}
