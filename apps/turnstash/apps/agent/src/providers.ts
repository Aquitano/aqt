import type { Normalizer, ProviderId, SourceProvider, StreamId } from "@aqt/turnstash-core";
import { Context, Layer, type Option } from "effect";

export interface ProvidersShape {
  readonly sources: ReadonlyArray<SourceProvider>;
  readonly conversationKeyOf: (
    provider: ProviderId,
    streamId: StreamId,
    payload: string,
  ) => Option.Option<string>;
}

export class Providers extends Context.Service<Providers, ProvidersShape>()(
  "@turnstash/Providers",
) {}

export const providersLayer = (
  sources: ReadonlyArray<SourceProvider>,
  normalizers: Readonly<Record<ProviderId, Normalizer>>,
) =>
  Layer.succeed(Providers, {
    sources,
    conversationKeyOf: (provider, streamId, payload) =>
      normalizers[provider].conversationKeyOf(streamId, payload),
  });
