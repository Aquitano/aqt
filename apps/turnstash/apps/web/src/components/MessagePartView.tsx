import type { MessageView, ToolExecutionView } from "@aqt/turnstash-api";
import { Badge } from "@cloudflare/kumo";
import { ImageIcon } from "@phosphor-icons/react";

import { compact, json } from "../format";
import { Disclosure } from "./Disclosure";
import { HighlightedText } from "./HighlightedText";

type Part = MessageView["parts"][number];

export type ToolIndex = ReadonlyMap<string, ToolExecutionView>;

/**
 * Transcript text is untrusted: it is whatever the model and the user typed,
 * stored verbatim. It is rendered as text in a pre-wrap block, never as HTML
 * and never through a markdown-to-HTML pass.
 */
const PlainText = ({
  text,
  query,
}: {
  readonly text: string;
  readonly query?: string | undefined;
}) => (
  <pre className="part-text">
    <HighlightedText text={text} query={query} />
  </pre>
);

export const MessagePartView = ({
  part,
  tools,
  query,
  targeted = false,
}: {
  readonly part: Part;
  readonly tools: ToolIndex;
  readonly query?: string | undefined;
  readonly targeted?: boolean;
}) => {
  switch (part.type) {
    case "text":
      return <PlainText text={part.text} query={query} />;

    case "thinking":
      return (
        <Disclosure
          summary={part.redacted === true ? "Thinking (redacted)" : "Thinking"}
          defaultOpen={targeted}
        >
          <PlainText text={part.text} query={query} />
        </Disclosure>
      );

    case "tool_call":
      return (
        <div className="part">
          <span className="part-label">
            <Badge variant="neutral">tool</Badge>
            {part.name}
          </span>
          <Disclosure summary="Input" defaultOpen={targeted}>
            <pre className="part-code">
              <HighlightedText text={json(part.input)} query={query} />
            </pre>
          </Disclosure>
        </div>
      );

    case "tool_result": {
      const execution = tools.get(part.toolKey);
      const name = execution?.name ?? part.toolKey;
      const failed = part.isError === true || execution?.status === "error";
      return (
        <Disclosure summary={`Result of ${name}${failed ? " (error)" : ""}`} defaultOpen={targeted}>
          <pre className="part-code">
            <HighlightedText
              text={part.output ?? execution?.output ?? "(no output)"}
              query={query}
            />
          </pre>
        </Disclosure>
      );
    }

    case "image":
      return (
        <span className="part-label">
          <ImageIcon size={14} />
          Image {part.mediaType ?? "of unknown type"}
          {part.bytes !== undefined && ` · ${compact(part.bytes)} bytes`}
        </span>
      );

    case "opaque":
      return (
        <Disclosure summary={`Unmapped ${part.kind}`} defaultOpen={targeted}>
          <pre className="part-code">
            <HighlightedText text={json(part.data)} query={query} />
          </pre>
        </Disclosure>
      );
  }
};
