import { brand } from "../brand";
import { Across, Down, Flow, Fork, Node } from "../diagram";
import { Cell, Cells, Prompt, Ref, Section } from "../parts";
import type { RefId } from "../records";

const cited: RefId = "bank:a04d77e19c52";

export function Refs() {
  return (
    <Section
      id="refs"
      title="Every record has a ref."
      sub="A stable ID for a message, a library record, an attachment or a file on a drive. Paste it into a note and resolve it years later."
    >
      <figure className="frame mono border-rule bg-panel text-code border">
        <figcaption className="border-rule flex flex-wrap items-baseline justify-between gap-x-6 border-b px-4 py-3 sm:px-6">
          <span>
            <Prompt>
              {brand.cmd} ref {cited}
            </Prompt>
          </span>
          <span className="text-faint whitespace-nowrap">sample data</span>
        </figcaption>
        <div className="grid gap-y-1 px-4 py-8 sm:px-6 xl:flex xl:items-center xl:gap-x-2 xl:py-12">
          <Node sub="cited in a note" className="xl:shrink-0" strong>
            <Ref id={cited} />
          </Node>
          <Flow at="xl" label="names" />
          <Node sub="mail to Property office" className="xl:shrink-0">
            <span className="text-mail">Fwd: Signed lease</span>
          </Node>
          <Flow at="xl" label="attachment" />
          <Node sub="attachment 91d0c4…e7a2" className="xl:shrink-0">
            lease_signed.pdf
          </Node>
          <Down label="same bytes" className="xl:hidden" />
          <Across open label="same bytes" className="min-w-28 max-xl:hidden" />
          <Fork className="my-[1.45rem] max-xl:hidden" />
          <span className="border-rule grid gap-2 max-xl:border max-xl:border-dashed max-xl:p-2 xl:shrink-0">
            <Node sub="/scans/2024/">
              <span className="text-drives">archive-2</span>
            </Node>
            <Node sub="/backup/">
              <span className="text-drives">nas</span>
            </Node>
          </span>
        </div>
      </figure>

      <Cells cols={3}>
        <Cell
          fold
          title="Derived, not assigned"
          text="A message ref is the first 12 hex digits of SHA‑256 over its source and its import key: the Message-ID header for mail, the source's own ID for chats, or a hash of the content when the export has neither. Rebuild the archive from its exports and every message gets the same ref."
        >
          <span className="border-rule grid grid-cols-2 gap-2 border border-dashed p-2">
            <Node sub="source">gmail</Node>
            <Node sub="message ID">{"<CAF2k9…>"}</Node>
          </span>
          <Down label="SHA-256, first 12 hex digits" className="lg:hidden" />
          <Down label="SHA-256" className="max-lg:hidden" />
          <Node sub="digest" className="max-lg:hidden">
            a04d77e19c52<span className="text-faint font-normal">8f03b1c4…</span>
          </Node>
          <Down label="first 12 digits" className="max-lg:hidden" />
          <Node strong sub="the same after every rebuild">
            bank:a04d77e19c52
          </Node>
        </Cell>
        <Cell
          title="Four kinds, one command"
          text="Messages, library records, files on drives and attachments each have their own form. One command resolves all four. For attachments and files, it also finds other copies of the same bytes."
        >
          <span className="border-rule grid gap-2 border border-dashed p-2">
            <Node compact sub="a message">
              <span className="text-mail">bank:a04d77e19c52</span>
            </Node>
            <Node compact sub="a library record">
              <span className="text-library">activity_4c9e21f0…</span>
            </Node>
            <Node
              compact
              sub={
                <>
                  <span className="lg:hidden">on drives</span>
                  <span className="max-lg:hidden">a file's bytes on drives</span>
                </>
              }
            >
              <span className="text-drives">attic:7c1e5ab04f2d9e61</span>
            </Node>
            <Node
              compact
              sub={
                <>
                  an attachment<span className="max-lg:hidden">, by SHA-256</span>
                </>
              }
            >
              91d0c4…e7a2
            </Node>
          </span>
          <Down label={`${brand.cmd} ref`} />
          <Node strong sub="and any other copies of the same bytes">
            what it names
          </Node>
        </Cell>
        <Cell
          fold
          title="Retired refs still resolve"
          text="When records move, such as YouTube watches from messages to the library, the old rows are deleted and leave a tombstone. The old ref resolves to that tombstone, which says what it named and, if the move recorded it, what replaced it."
        >
          <Node sub="a YouTube watch, imported as a message">bank:0d94aa17e6b3</Node>
          <Down label="retired 2025-03-02" />
          <Node dashed sub="the ref still resolves here">
            tombstone
          </Node>
          <Down label="replaced by" />
          <Node strong sub="the library record that replaced it">
            <span className="text-library">activity_4c9e21f0…</span>
          </Node>
        </Cell>
      </Cells>
    </Section>
  );
}
