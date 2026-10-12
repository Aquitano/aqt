import { batchLimits, type RecordKey } from "@aqt/turnstash-core";
import { Schema } from "effect";

export interface SkippedRecord {
  readonly recordKey: RecordKey;
  readonly bytes: number;
}

export const ExtractionLimits = Schema.Struct({
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: batchLimits.maxBytes })),
  maxRecords: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: batchLimits.maxRecords })),
});

export type ExtractionLimits = typeof ExtractionLimits.Type;

export const extractionLimits = (options: Partial<ExtractionLimits>) =>
  Schema.decodeUnknownEffect(ExtractionLimits)({ ...batchLimits, ...options });

export class RecordTooLarge extends Schema.TaggedError<RecordTooLarge>()("RecordTooLarge", {
  path: Schema.String,
  maxBytes: Schema.Natural,
}) {}
