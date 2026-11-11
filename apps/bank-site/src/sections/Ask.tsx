import { useState, type ReactNode } from "react";

import { brand } from "../brand";
import { Note, Prompt, Section, Terminal } from "../ui";

const c = brand.cmd;

type Panel = { id: string; tab: string; route: string; session: ReactNode; note: ReactNode };

const panels: [Panel, ...Panel[]] = [
  {
    id: "search",
    tab: "Find it",
    route: "GET /v1/find",
    session: (
      <>
        <Prompt>{c} search "tax assessment 2023" --since 2024-01-01</Prompt>
        {"\n"}
        <span className="text-mail">mail </span> <span className="ref">51c0e7a2bb19</span>
        {"    2024-05-02  Tax office: assessment 2023\n"}
        <span className="text-library">library </span> <span className="ref">e77a0c93d1f4</span>
        {"    2024-05-02  assessment_2023.pdf, page 2\n"}
        <span className="text-disks">disks </span> <span className="ref">attic:b2904fe1</span>
        {"  2024-05-03  nas:/taxes/2023/assessment.pdf"}
      </>
    ),
    note: (
      <>
        <p>
          <strong className="text-ink font-medium">One query covers every kind of record.</strong>{" "}
          Mail, chats, the text inside attachments and files on drives come back as groups in one
          result.
        </p>
        <p>
          Ranking is BM25 inside Postgres, through ParadeDB. There is no second search service to
          keep in sync.
        </p>
      </>
    ),
  },
  {
    id: "timeline",
    tab: "What happened that day",
    route: "GET /v1/timeline",
    session: (
      <>
        <Prompt>{c} timeline 2024-02-26</Prompt>
        {"\n"}
        {"09:14  "}
        <span className="text-chat">chat </span> <span className="ref">9be2f0416a3d</span>
        {"    Anna: did you already transfer…\n"}
        {"09:40  "}
        <span className="text-disks">disks </span> <span className="ref">attic:7c1e5ab0</span>
        {"  lease_signed.pdf written\n"}
        {"11:02  "}
        <span className="text-mail">mail </span> <span className="ref">a04d77e19c52</span>
        {"    Fwd: Signed lease\n"}
        {"16:31  "}
        <span className="text-ai">ai </span> <span className="ref">c18f3d9e0a77</span>
        {"    summarise the handover checklist"}
      </>
    ),
    note: (
      <>
        <p>
          <strong className="text-ink font-medium">A year, a month or a day, in order.</strong>{" "}
          Messages, things you watched and files you changed, merged into one feed.
        </p>
        <p>
          Each kind is limited separately, so a backup that touched 4,000 files does not push the
          one message off the page.
        </p>
      </>
    ),
  },
  {
    id: "ref",
    tab: "What is this ref",
    route: "GET /v1/refs/{ref}",
    session: (
      <>
        <Prompt>{c} ref a04d77e19c52</Prompt>
        {"\n"}
        <span className="text-faint">message </span>
        {"mail  2024-02-27  me to Property office\n"}
        <span className="text-faint">attachment </span>
        {"lease_signed.pdf  sha256 91d0…  blake3 7c1e…\n"}
        <span className="text-faint">also on </span>
        {"archive-2:/scans/2024/lease_signed.pdf\n"}
        {"            nas:/backup/documents/lease_signed.pdf"}
      </>
    ),
    note: (
      <>
        <p>
          <strong className="text-ink font-medium">A ref is a citation that keeps working.</strong>{" "}
          It is derived from the record itself, so rebuilding the database does not change it.
        </p>
        <p>
          An agent writes <span className="mono text-code">bank:3fa91c20b7e4</span> next to a claim.
          Anyone can resolve it later and see the message, its attachments and every other copy of
          the same bytes.
        </p>
      </>
    ),
  },
  {
    id: "text",
    tab: "What does it say",
    route: `${c} extract`,
    session: (
      <>
        <Prompt>{c} extract</Prompt>
        {"\n"}
        {"scan_0412.pdf     ok   attic: ocr       "}
        <span className="text-faint">taken from the catalogue</span>
        {"\n"}
        {"invoice_771.pdf   ok   pdf              "}
        <span className="text-faint">3 pages</span>
        {"\n"}
        {"whiteboard.jpg    ok   ocr tesseract    "}
        <span className="text-faint">1 page</span>
      </>
    ),
    note: (
      <>
        <p>
          <strong className="text-ink font-medium">
            Search covers what a file says, not what it is called.
          </strong>{" "}
          PDFs, office documents and scans are read on arrival, with OCR where there is no text
          layer.
        </p>
        <p>
          Identical bytes are read once. A scan that sits on a drive and in a mail is matched by
          hash, and the text one side extracted is used by the other.
        </p>
      </>
    ),
  },
];

export function Ask() {
  const [active, setActive] = useState(panels[0].id);
  const panel = panels.find((p) => p.id === active) ?? panels[0];

  return (
    <Section
      id="ask"
      title="What an agent can ask"
      lede="Four questions cover most of what a second brain needs from its raw material. Each one is a command and a typed HTTP route, and each answer carries refs."
    >
      <div
        role="tablist"
        aria-label="Questions"
        className="mono flex flex-wrap gap-x-8 gap-y-2 text-[0.85rem]"
      >
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`ask-tab-${p.id}`}
            aria-selected={p.id === active}
            aria-controls="ask-panel"
            onClick={() => setActive(p.id)}
            className="text-faint hover:text-ink aria-selected:border-ink aria-selected:text-ink cursor-pointer border-b border-transparent pb-1.5"
          >
            {p.tab}
          </button>
        ))}
      </div>
      <div
        id="ask-panel"
        role="tabpanel"
        aria-labelledby={`ask-tab-${panel.id}`}
        className="mt-8 grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]"
      >
        <Terminal title={panel.route}>{panel.session}</Terminal>
        <Note>{panel.note}</Note>
      </div>
    </Section>
  );
}
