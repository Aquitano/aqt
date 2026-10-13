import {
  Api,
  NotFound,
  PlanEndsBeforeStart,
  PlanOverlap,
  TimelineChanged,
  Unauthorized,
} from "@aqt/turnstash-api";
import { Effect, Match } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const tokenKey = "cb_token";

export const readToken = (): string => {
  try {
    return localStorage.getItem(tokenKey) ?? "";
  } catch {
    return "";
  }
};

export const writeToken = (token: string): void => {
  try {
    if (token === "") localStorage.removeItem(tokenKey);
    else localStorage.setItem(tokenKey, token);
  } catch {
    // A blocked storage means the token lives for this page load only.
  }
};

export const api = Effect.runSync(
  HttpApiClient.make(Api, {
    transformClient: HttpClient.mapRequest((request) => {
      const token = readToken();
      return token === "" ? request : HttpClientRequest.bearerToken(request, token);
    }),
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

// Statuses an endpoint does not declare, and error bodies that do not decode, arrive as an HttpClientError.
const responseStatus = (error: Error): number | undefined =>
  HttpClientError.isHttpClientError(error) ? error.response?.status : undefined;

export const isUnauthorized = (error: Error): boolean =>
  error instanceof Unauthorized || responseStatus(error) === 401;

export const isTimelineChanged = (error: Error): boolean => error instanceof TimelineChanged;

export const failureMessage = (error: Error): string =>
  Match.value(error).pipe(
    Match.when(Match.instanceOf(NotFound), ({ entity, id }) => `No ${entity} with id ${id}.`),
    Match.when(
      Match.instanceOf(PlanOverlap),
      ({ existing }) =>
        `These dates overlap ${existing.name}, ${existing.startedOn} to ${existing.endedOn ?? "now"}. Shorten or delete that period first.`,
    ),
    Match.when(
      Match.instanceOf(PlanEndsBeforeStart),
      ({ startedOn, endedOn }) =>
        `A period cannot end on ${endedOn}, before it starts on ${startedOn}.`,
    ),
    Match.orElse((other) => {
      const status = responseStatus(other);
      return status === undefined ? other.message : `The server responded with HTTP ${status}.`;
    }),
  );
