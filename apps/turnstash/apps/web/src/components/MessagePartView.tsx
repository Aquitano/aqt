import type { MessageView, ToolExecutionView } from "@aqt/turnstash-api";
import { Badge } from "@aqt/ui/components/badge";
import { ImageIcon } from "lucide-react";

import { compact, json } from "../format";
import { Disclosure } from "./Disclosure";
import { HighlightedText } from "./HighlightedText";

type Part = MessageView["parts"][number];

export type ToolIndex = ReadonlyMap<string, ToolExecutionView>;

export const codeBlock =
  "m-0 max-h-105 overflow-auto rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap wrap-anywhere";

const partLabel = "flex items-center gap-1.5 text-xs text-muted-foreground";

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
  <pre className="m-0 max-w-[80ch] font-sans text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
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
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={partLabel}>
            <Badge variant="secondary">tool</Badge>
            {part.name}
          </span>
          <Disclosure summary="Input" defaultOpen={targeted}>
            <pre className={codeBlock}>
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
          <pre className={codeBlock}>
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
        <span className={partLabel}>
          <ImageIcon className="size-3.5" />
          Image {part.mediaType ?? "of unknown type"}
          {part.bytes !== undefined && ` · ${compact(part.bytes)} bytes`}
        </span>
      );

    case "opaque":
      return (
        <Disclosure summary={`Unmapped ${part.kind}`} defaultOpen={targeted}>
          <pre className={codeBlock}>
            <HighlightedText text={json(part.data)} query={query} />
          </pre>
        </Disclosure>
      );
  }
};
