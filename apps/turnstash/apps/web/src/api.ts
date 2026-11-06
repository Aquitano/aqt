import { Api, NotFound, PlanEndsBeforeStart, PlanOverlap, Unauthorized } from "@aqt/turnstash-api";
import { Effect, Match } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

const tokenKey = "cb_token";
let memoryToken = "";
let tokenWriteFailed = false;

export const readToken = (): string => {
  if (tokenWriteFailed) return memoryToken;
  try {
    memoryToken = localStorage.getItem(tokenKey) ?? "";
  } catch {
    return memoryToken;
  }
  return memoryToken;
};

export const writeToken = (token: string): void => {
  memoryToken = token;
  try {
    if (token === "") localStorage.removeItem(tokenKey);
    else localStorage.setItem(tokenKey, token);
    tokenWriteFailed = false;
  } catch {
    tokenWriteFailed = true;
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
  error instanceof Unauthorized || responseStatus(error) === 401 || responseStatus(error) === 403;

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
