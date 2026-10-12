import { highlightSegments } from "../search-state";

export const HighlightedText = ({
  text,
  query = "",
}: {
  readonly text: string;
  readonly query?: string | undefined;
}) =>
  highlightSegments(text, query).map((segment, index) =>
    segment.matched ? <mark key={index}>{segment.text}</mark> : segment.text,
  );
