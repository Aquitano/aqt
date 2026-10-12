import type { Normalizer, ProviderId } from "@aqt/turnstash-core";
import { Context, Layer } from "effect";

export type NormalizerRegistry = Readonly<Record<ProviderId, Normalizer>>;

export class Normalizers extends Context.Service<Normalizers, NormalizerRegistry>()(
  "@turnstash/Normalizers",
) {}

export const normalizersLayer = (registry: NormalizerRegistry) =>
  Layer.succeed(Normalizers, registry);
