import type { NormalizedToolExecution, ToolStatus } from "@aqt/turnstash-core";
import type { Schema } from "effect";

export interface ToolDraft {
  messageKey: string | undefined;
  name: string;
  input: Schema.Json;
  output: string | null;
  status: ToolStatus;
  startedAt: string | undefined;
  endedAt: string | undefined;
}

export const toolExecutionOf = (toolKey: string, draft: ToolDraft): NormalizedToolExecution => ({
  toolKey,
  ...(draft.messageKey === undefined ? {} : { messageKey: draft.messageKey }),
  name: draft.name,
  input: draft.input,
  output: draft.output,
  status: draft.status,
  ...(draft.startedAt === undefined ? {} : { startedAt: draft.startedAt }),
  ...(draft.endedAt === undefined ? {} : { endedAt: draft.endedAt }),
});
