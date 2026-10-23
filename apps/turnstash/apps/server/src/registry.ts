import {
  extractInlineBlobs,
  type Normalizer,
  type ProviderId,
  type StreamId,
} from "@aqt/turnstash-core";
import { Context, Layer } from "effect";

export type NormalizerRegistry = Readonly<Record<ProviderId, Normalizer>>;

export class Normalizers extends Context.Service<Normalizers, NormalizerRegistry>()(
  "@turnstash/Normalizers",
) {}

export const normalizersLayer = (registry: NormalizerRegistry) =>
  Layer.succeed(Normalizers, registry);

// The record the archive keeps: the provider's trim, with inline images and documents moved out into blobs.
export const storedRecordOf = (normalizer: Normalizer, streamId: StreamId, payload: string) =>
  extractInlineBlobs(normalizer.trim?.(streamId, payload) ?? payload);
