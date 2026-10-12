import { Button } from "@cloudflare/kumo";
import { useState } from "react";

import { MarkdownExportButton } from "./MarkdownExportButton";

export const useExportSelection = () => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string, on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const clear = () => setSelected(new Set());
  return { selected, toggle, clear };
};

export const SelectionBar = ({
  conversationId,
  kind,
  selected,
  onClear,
}: {
  readonly conversationId: string;
  readonly kind: "messages" | "turns";
  readonly selected: ReadonlySet<string>;
  readonly onClear: () => void;
}) => {
  if (selected.size === 0) return null;
  return (
    <div className="selection-bar row">
      <span>{`${selected.size} ${kind} selected`}</span>
      <MarkdownExportButton
        conversationId={conversationId}
        selection={{ kind, messageKeys: [...selected] }}
        label={`Export selected ${kind}`}
      />
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  );
};

export const SelectForExport = ({
  label,
  messageKey,
  selection,
}: {
  readonly label: string;
  readonly messageKey: string;
  readonly selection: ReturnType<typeof useExportSelection>;
}) => (
  <label className="export-option">
    <input
      type="checkbox"
      aria-label={label}
      checked={selection.selected.has(messageKey)}
      onChange={(event) => selection.toggle(messageKey, event.target.checked)}
    />
    Select
  </label>
);
