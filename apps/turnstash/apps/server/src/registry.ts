import {
  type Normalizer,
  omitInlineBlobs,
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

// The payload the archive keeps: the provider's trim, with inline images and documents reduced to the type
// and size a conversation shows of them.
export const storedPayloadOf = (normalizer: Normalizer, streamId: StreamId, payload: string) =>
  omitInlineBlobs(normalizer.trim?.(streamId, payload) ?? payload);
