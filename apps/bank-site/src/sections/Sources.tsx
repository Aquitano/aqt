import { kindColor, type Kind } from "../brand";
import { Note, Section } from "../ui";

type Source = { kind: Kind; name: string; arrives: string; becomes: string; state?: string };

const sources: Source[] = [
  {
    kind: "mail",
    name: "Gmail",
    arrives: "API sync or a Takeout mbox",
    becomes: "threads, messages, attachments",
  },
  {
    kind: "mail",
    name: "Any IMAP account",
    arrives: "collected continuously",
    becomes: "threads, messages, attachments",
  },
  {
    kind: "mail",
    name: "Mail files",
    arrives: ".eml files and folder trees",
    becomes: "threads, with folders kept",
  },
  { kind: "chat", name: "WhatsApp", arrives: "chat export", becomes: "messages and media" },
  { kind: "chat", name: "Discord", arrives: "data package", becomes: "messages" },
  { kind: "chat", name: "LinkedIn", arrives: "data export", becomes: "messages" },
  {
    kind: "ai",
    name: "ChatGPT, Claude",
    arrives: "data export",
    becomes: "conversations as threads",
  },
  {
    kind: "library",
    name: "YouTube, Netflix",
    arrives: "watch history export",
    becomes: "items and dated activity",
  },
  {
    kind: "library",
    name: "Documents",
    arrives: "upload, Markdown pages",
    becomes: "files, pages, collections",
  },
  {
    kind: "disks",
    name: "Drives and folders",
    arrives: "scanner on the machine",
    becomes: "files, contents, OCR text",
    state: "in review",
  },
];

export function Sources() {
  return (
    <Section
      id="sources"
      title="What goes in"
      lede="Importers read the exports and protocols you already have. Running one again adds only what is new. The original export is kept beside the records, so any import can be replayed by a better importer later."
    >
      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <div className="min-w-0 overflow-x-auto">
          <table className="mono text-code w-full min-w-[34rem]">
            <thead>
              <tr className="text-faint text-left">
                <th className="pr-4 pb-3 font-normal">Kind</th>
                <th className="pr-4 pb-3 font-normal">Source</th>
                <th className="pr-4 pb-3 font-normal">Arrives as</th>
                <th className="pb-3 font-normal">Becomes</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.name} className="border-rule-soft border-t align-top">
                  <td className={`py-2.5 pr-4 ${kindColor[s.kind]}`}>{s.kind}</td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">
                    {s.name}
                    {s.state ? <span className="text-faint"> ({s.state})</span> : null}
                  </td>
                  <td className="text-dim py-2.5 pr-4">{s.arrives}</td>
                  <td className="text-dim py-2.5">{s.becomes}</td>
                </tr>
              ))}
              <tr className="border-rule-soft border-t align-top">
                <td className="text-faint py-2.5 pr-4">any</td>
                <td className="py-2.5 pr-4 whitespace-nowrap">Everything else</td>
                <td className="text-dim py-2.5 pr-4">JSON lines on stdin</td>
                <td className="text-dim py-2.5">messages with your own source name</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note>
          <p>
            <strong className="text-ink font-medium">Records are never rewritten.</strong> A message
            is stored as it arrived. Deleting one leaves a tombstone, so an old citation says what
            happened to it.
          </p>
          <p>
            <strong className="text-ink font-medium">Drives are catalogued, not copied.</strong> The
            scanner records what is on a drive and what the files say. The drive can go back in the
            drawer and still be searched.
          </p>
        </Note>
      </div>
    </Section>
  );
}
