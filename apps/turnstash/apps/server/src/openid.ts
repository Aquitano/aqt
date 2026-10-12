import { Context, Effect, Exit, Layer, Redacted, Schema } from "effect";
import * as oidc from "openid-client";

import { type OidcAuth, ServerConfig } from "./config.ts";

export const callbackPath = "/auth/callback";

export class LoginFailure extends Schema.TaggedError<LoginFailure>()("LoginFailure", {
  step: Schema.Literals([
    "disabled",
    "login",
    "discovery",
    "authorization",
    "exchange",
    "claims",
    "subject",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface LoginState {
  readonly state: string;
  readonly verifier: string;
  readonly nonce: string;
}

export interface LoginStart extends LoginState {
  readonly url: string;
}

export interface Identity {
  readonly subject: string;
  readonly name: string;
}

export interface OpenIdShape {
  readonly start: () => Effect.Effect<LoginStart, LoginFailure>;
  readonly finish: (callback: URL, login: LoginState) => Effect.Effect<Identity, LoginFailure>;
}

export class OpenId extends Context.Service<OpenId, OpenIdShape>()("@turnstash/OpenId") {}

const IdTokenClaims = Schema.Struct({
  sub: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String),
});

const attempt = <A>(step: LoginFailure["step"], run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new LoginFailure({ step, cause }) });

// Discovery is cached so unauthenticated /auth/login requests cannot make the server refetch the issuer's
// metadata on every call; a failed discovery is retried on the next login instead of being cached.
const make = Effect.fn("OpenId.make")(function* (auth: OidcAuth) {
  const redirectUri = `${auth.origin}${callbackPath}`;

  const discover = yield* attempt("discovery", () =>
    oidc.discovery(
      new URL(auth.issuer),
      auth.clientId,
      Redacted.value(auth.clientSecret),
      undefined,
      {
        timeout: 10,
        execute: [oidc.enableNonRepudiationChecks],
      },
    ),
  ).pipe(Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "1 hour" : 0)));

  const start = Effect.fn("OpenId.start")(function* () {
    const client = yield* discover;
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = yield* attempt("authorization", async () =>
      oidc.buildAuthorizationUrl(client, {
        redirect_uri: redirectUri,
        scope: "openid profile",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      }),
    );
    return { state, verifier, nonce, url: url.href };
  });

  const finish = Effect.fn("OpenId.finish")(function* (callback: URL, login: LoginState) {
    const client = yield* discover;
    const tokens = yield* attempt("exchange", () =>
      oidc.authorizationCodeGrant(client, callback, {
        pkceCodeVerifier: login.verifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      }),
    );
    const claims = yield* Schema.decodeUnknownEffect(IdTokenClaims)(tokens.claims()).pipe(
      Effect.mapError((cause) => new LoginFailure({ step: "claims", cause })),
    );
    if (claims.sub !== auth.adminSubject) return yield* new LoginFailure({ step: "subject" });
    return { subject: claims.sub, name: claims.name ?? "Administrator" };
  });

  return { start, finish } satisfies OpenIdShape;
});

const disabled: OpenIdShape = {
  start: () => Effect.fail(new LoginFailure({ step: "disabled" })),
  finish: () => Effect.fail(new LoginFailure({ step: "disabled" })),
};

export const OpenIdLive = Layer.effect(
  OpenId,
  Effect.flatMap(ServerConfig, ({ auth }) =>
    auth.mode === "oidc" ? make(auth) : Effect.succeed(disabled),
  ),
);
