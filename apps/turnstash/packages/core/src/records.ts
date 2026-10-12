import { Schema } from "effect";

import { HostOs } from "./host.ts";
import { ProviderId } from "./provider.ts";

export const Uuid = Schema.String.check(Schema.isUUID());

// PostgreSQL text cannot hold NUL, so a parameter containing one would fail in the query with a 500.
export const NulFreeString = Schema.String.check(
  Schema.makeFilter((value) => !value.includes("\u0000")),
);

export const MachineId = Uuid.pipe(Schema.brand("MachineId"));
export type MachineId = typeof MachineId.Type;

export const StreamId = Schema.NonEmptyString.pipe(Schema.brand("StreamId"));
export type StreamId = typeof StreamId.Type;

export const RecordKey = Schema.NonEmptyString.pipe(Schema.brand("RecordKey"));
export type RecordKey = typeof RecordKey.Type;

export const ConversationKey = Schema.NonEmptyString.pipe(Schema.brand("ConversationKey"));
export type ConversationKey = typeof ConversationKey.Type;

export const IsoTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
  Schema.makeFilter((value) => {
    const milliseconds = Date.parse(value);
    return (
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() ===
        (value.includes(".") ? value : value.replace("Z", ".000Z"))
    );
  }),
);
export type IsoTimestamp = typeof IsoTimestamp.Type;

export const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value) => Schema.is(IsoTimestamp)(`${value}T00:00:00Z`)),
);

export const ContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const batchLimits = {
  maxRecords: 500,
  maxBytes: 8 * 1024 * 1024,
} as const;

export const encodedJsonBytes = (value: Schema.Json): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const WireRecord = Schema.Struct({
  provider: ProviderId,
  streamId: StreamId,
  recordKey: RecordKey,
  contentHash: ContentHash,
  payload: Schema.String,
  observedAt: IsoTimestamp,
  redactions: Schema.Natural,
});
export type WireRecord = typeof WireRecord.Type;

export const IngestBatchMetadata = Schema.Struct({
  batchId: Uuid,
  machineId: MachineId,
  agentVersion: Schema.NonEmptyString,
});
export type IngestBatchMetadata = typeof IngestBatchMetadata.Type;

export const IngestBatch = Schema.Struct({
  ...IngestBatchMetadata.fields,
  records: Schema.Array(WireRecord).check(Schema.isMaxLength(batchLimits.maxRecords)),
}).check(Schema.makeFilter((value) => encodedJsonBytes(value) <= batchLimits.maxBytes));
export type IngestBatch = typeof IngestBatch.Type;

export const IngestResult = Schema.Struct({
  batchId: Uuid,
  accepted: Schema.Natural,
  duplicates: Schema.Natural,
  replaced: Schema.Natural,
});
export type IngestResult = typeof IngestResult.Type;

export const EnrollRequest = Schema.Struct({
  name: NulFreeString.check(Schema.isNonEmpty()),
  os: HostOs,
  arch: NulFreeString,
  agentVersion: NulFreeString,
});
export type EnrollRequest = typeof EnrollRequest.Type;

export const EnrollResponse = Schema.Struct({
  machineId: MachineId,
  token: Schema.String,
});
export type EnrollResponse = typeof EnrollResponse.Type;

export const Tombstone = Schema.Struct({
  provider: ProviderId,
  conversationKey: ConversationKey,
  deletedAt: IsoTimestamp,
});
export type Tombstone = typeof Tombstone.Type;
