const highlighted = /^<b>[\s\S]*<\/b>$/;

/**
 * BM25 snippets arrive with `<b>` around the matched terms. They are split into
 * text nodes here and never handed to `dangerouslySetInnerHTML`: the rest of
 * the snippet is transcript text and must not be parsed as markup.
 */
export const Snippet = ({ text }: { readonly text: string }) => (
  <p className="m-0 max-w-[90ch] font-sans text-[13px] leading-normal wrap-anywhere whitespace-pre-wrap text-muted-foreground">
    {text.split(/(<b>[\s\S]*?<\/b>)/).map((part, index) =>
      highlighted.test(part) ? (
        <mark key={index} className="rounded-[3px] bg-flame/30 px-0.5 text-foreground">
          {part.slice(3, -4)}
        </mark>
      ) : (
        <span key={index}>{part}</span>
      ),
    )}
  </p>
);
