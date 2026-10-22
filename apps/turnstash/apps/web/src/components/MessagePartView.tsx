import { useQuery } from "@tanstack/react-query";
import { absurd } from "effect/Function";
import { ImageIcon } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { compact, json } from "../format";
import { blobQuery } from "../queries";
import type { ContentPart } from "../transcript";
import { Async } from "./Async";
import { Disclosure } from "./Disclosure";
import { HighlightedText } from "./HighlightedText";

export const codeBlock =
  "m-0 max-h-105 overflow-auto rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap wrap-anywhere";

const partLabel = "flex items-center gap-1.5 text-xs text-muted-foreground";

/**
 * Transcript text is untrusted: it is whatever the model and the user typed, stored verbatim.
 * Plain text renders in a pre-wrap block. Assistant markdown goes through react-markdown, which
 * builds React elements and turns raw HTML into literal text; images are dropped so a transcript
 * cannot load remote content.
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

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export const Markdown = ({ text }: { readonly text: string }) => (
  <div className="prose prose-sm max-w-[80ch] wrap-anywhere dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold prose-p:my-2 prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:max-h-105 prose-pre:overflow-auto prose-pre:bg-muted prose-pre:text-xs prose-pre:text-foreground prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-table:my-2 prose-table:block prose-table:overflow-x-auto">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      disallowedElements={["img"]}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  </div>
);

const StoredImage = ({
  sha256,
  mediaType,
}: {
  readonly sha256: string;
  readonly mediaType: string | undefined;
}) => {
  const image = useQuery(blobQuery(sha256, mediaType));
  return (
    <Async query={image}>
      {(src) => (
        <img src={src} alt="Archived image" className="max-h-160 max-w-full rounded-md border" />
      )}
    </Async>
  );
};

// Search highlights only exist on plain text, so a transcript opened from a search stays plain.
export const MessagePartView = ({
  part,
  markdown,
  query,
  targeted = false,
}: {
  readonly part: ContentPart;
  readonly markdown: boolean;
  readonly query?: string | undefined;
  readonly targeted?: boolean;
}) => {
  switch (part.type) {
    case "text":
      return markdown && query === undefined ? (
        <Markdown text={part.text} />
      ) : (
        <PlainText text={part.text} query={query} />
      );

    case "thinking":
      return (
        <Disclosure
          summary={part.redacted === true ? "Thinking (redacted)" : "Thinking"}
          defaultOpen={targeted}
        >
          <PlainText text={part.text} query={query} />
        </Disclosure>
      );

    case "image": {
      const label = (
        <span className={partLabel}>
          <ImageIcon className="size-3.5" />
          Image {part.mediaType ?? "of unknown type"}
          {part.bytes !== undefined && ` · ${compact(part.bytes)} bytes`}
        </span>
      );
      return part.sha256 === undefined ? (
        label
      ) : (
        <Disclosure summary={label} defaultOpen={targeted}>
          <StoredImage sha256={part.sha256} mediaType={part.mediaType} />
        </Disclosure>
      );
    }

    case "opaque":
      return (
        <Disclosure summary={`Unmapped ${part.kind}`} defaultOpen={targeted}>
          <pre className={codeBlock}>
            <HighlightedText text={json(part.data)} query={query} />
          </pre>
        </Disclosure>
      );

    default:
      return absurd<ReactNode>(part);
  }
};
