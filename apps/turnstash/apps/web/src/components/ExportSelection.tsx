import { Button } from "@aqt/ui/components/button";
import { Checkbox } from "@aqt/ui/components/checkbox";
import { Label } from "@aqt/ui/components/label";
import { useState } from "react";

import { MarkdownExportButton } from "./MarkdownExportButton";

export const useExportSelection = () => {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = (keys: ReadonlyArray<string>, on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
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
    <div className="flex flex-wrap items-center gap-2 py-3">
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
  messageKeys,
  selection,
}: {
  readonly label: string;
  readonly messageKeys: ReadonlyArray<string>;
  readonly selection: ReturnType<typeof useExportSelection>;
}) => (
  <Label className="gap-1.5 text-xs font-normal whitespace-nowrap">
    <Checkbox
      aria-label={label}
      checked={messageKeys.every((key) => selection.selected.has(key))}
      onCheckedChange={(checked) => selection.toggle(messageKeys, checked)}
    />
    Select
  </Label>
);
