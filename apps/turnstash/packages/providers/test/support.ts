import { RecordKey, type SourceRecordRow, type StreamId } from "@aqt/turnstash-core";

export const jsonlRows = (
  streamId: StreamId,
  text: string,
  observedAt: string,
): ReadonlyArray<SourceRecordRow> => {
  const rows: Array<SourceRecordRow> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "")
      rows.push({ streamId, recordKey: RecordKey.make(String(offset)), payload: line, observedAt });
    offset += Buffer.byteLength(line) + 1;
  }
  return rows;
};

// Mirrors the agent's SQLite extraction: row columns as JSON with sorted keys.
export const canonical = (row: Record<string, unknown>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, row[key]] as const),
    ),
  );
