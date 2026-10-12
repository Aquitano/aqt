import type { ExportSelection } from "@aqt/turnstash-api";
import { Button } from "@cloudflare/kumo";
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
    <div className="export-action">
      <div className="row">
        <Button size="sm" loading={download.isPending} onClick={() => download.mutate()}>
          {label}
        </Button>
        <label className="export-option">
          <input
            type="checkbox"
            checked={includeTools}
            onChange={(event) => setIncludeTools(event.target.checked)}
          />
          Include tool output
        </label>
      </div>
      {download.isError && <RequestFailure error={download.error} />}
    </div>
  );
};
