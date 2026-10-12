import type { ExportSelection } from "@aqt/turnstash-api";
import { Button } from "@aqt/ui/components/button";
import { Checkbox } from "@aqt/ui/components/checkbox";
import { Label } from "@aqt/ui/components/label";
import { Spinner } from "@aqt/ui/components/spinner";
import { useMutation } from "@tanstack/react-query";
import { Effect } from "effect";
import { useState } from "react";

import { api } from "../api";
import { RequestFailure } from "./Async";

export const MarkdownExportButton = ({
  conversationId,
  selection,
  label = "Export Markdown",
}: {
  readonly conversationId: string;
  readonly selection: ExportSelection;
  readonly label?: string;
}) => {
  const [includeTools, setIncludeTools] = useState(false);
  const download = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        api.read.exportMarkdown({
          params: { id: conversationId },
          payload: { selection, includeTools, sourceOrigin: window.location.origin },
        }),
      ),
    onSuccess: ({ markdown, filename }) => {
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={download.isPending}
          onClick={() => download.mutate()}
        >
          {download.isPending && <Spinner data-icon="inline-start" />}
          {label}
        </Button>
        <Label className="gap-1.5 text-xs font-normal whitespace-nowrap">
          <Checkbox checked={includeTools} onCheckedChange={setIncludeTools} />
          Include tool output
        </Label>
      </div>
      {download.isError && <RequestFailure error={download.error} />}
    </div>
  );
};
