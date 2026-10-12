import { expect, spyOn, test } from "bun:test";

import { ConfigProvider, Effect, Layer, Result } from "effect";

import { ServerConfigLive } from "../src/config.ts";
import { OpenId, OpenIdLive } from "../src/openid.ts";

const issuer = "https://issuer.test/application/o/turnstash/";
const clientId = "turnstash";
const subject = "owner";
const config = ServerConfigLive.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        DATABASE_URL: "postgres://unused",
        OIDC_ISSUER: issuer,
        OIDC_CLIENT_ID: clientId,
        OIDC_CLIENT_SECRET: "client-secret",
        OIDC_ADMIN_SUBJECT: subject,
        APP_ORIGIN: "https://turnstash.test",
      }),
    ),
  ),
);
const provider = OpenIdLive.pipe(Layer.provide(config));

const signingKey = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", signingKey.publicKey)),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signedToken = async (claims: Record<string, unknown>, invalidSignature: boolean) => {
  const input = `${encode({ alg: "RS256", kid: jwk.kid })}.${encode(claims)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signingKey.privateKey,
      new TextEncoder().encode(input),
    ),
  );
  if (invalidSignature) signature[0] = (signature[0] ?? 0) ^ 1;
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
};

test("OpenID uses PKCE and rejects invalid state, nonce, issuer, audience, subject and signatures", async () => {
  let nonce = "";
  let verifier = "";
  let overrides: Record<string, unknown> = {};
  let invalidSignature = false;
  let exchanges = 0;
  const upstream = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(".well-known/openid-configuration"))
          return Response.json({
            issuer,
            authorization_endpoint: "https://issuer.test/authorize",
            token_endpoint: "https://issuer.test/token",
            jwks_uri: "https://issuer.test/jwks",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            code_challenge_methods_supported: ["S256"],
          });
        if (url === "https://issuer.test/jwks") return Response.json({ keys: [jwk] });
        if (url === "https://issuer.test/token") {
          exchanges++;
          const form = new URLSearchParams(String(init?.body));
          expect(form.get("code_verifier")).toBe(verifier);
          expect(form.get("redirect_uri")).toBe("https://turnstash.test/auth/callback");
          const now = Math.floor(Date.now() / 1000);
          return Response.json({
            token_type: "Bearer",
            access_token: "unused-access-token",
            expires_in: 3600,
            id_token: await signedToken(
              {
                iss: issuer,
                aud: clientId,
                sub: subject,
                name: "Owner",
                nonce,
                iat: now,
                exp: now + 3600,
                ...overrides,
              },
              invalidSignature,
            ),
          });
        }
        throw new Error(`Unexpected OpenID request: ${url}`);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* OpenId;
        const login = yield* client.start();
        nonce = login.nonce;
        verifier = login.verifier;
        const authorization = new URL(login.url);
        expect(authorization.searchParams.get("state")).toBe(login.state);
        expect(authorization.searchParams.get("nonce")).toBe(nonce);
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorization.searchParams.get("code_challenge")).toBe(
          Buffer.from(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
            ),
          ).toString("base64url"),
        );
        const callback = new URL(
          `https://turnstash.test/auth/callback?code=code&state=${login.state}`,
        );
        expect(yield* client.finish(callback, login)).toEqual({ subject, name: "Owner" });
        for (const [invalid, step] of [
          [{ nonce: "wrong" }, "exchange"],
          [{ iss: "https://attacker.test" }, "exchange"],
          [{ aud: "another-app" }, "exchange"],
          [{ sub: "another-owner" }, "subject"],
          [{ exp: 1 }, "exchange"],
        ] as const) {
          overrides = invalid;
          const failure = yield* client.finish(callback, login).pipe(Effect.flip);
          expect(failure.step).toBe(step);
        }
        overrides = {};
        invalidSignature = true;
        expect((yield* client.finish(callback, login).pipe(Effect.flip)).step).toBe("exchange");
        invalidSignature = false;
        const before = exchanges;
        callback.searchParams.set("state", "wrong");
        expect((yield* client.finish(callback, login).pipe(Effect.flip)).step).toBe("exchange");
        expect(exchanges).toBe(before);
      }).pipe(Effect.provide(provider)),
    );
  } finally {
    upstream.mockRestore();
  }
});

test("incomplete OIDC configuration fails instead of enabling the admin token", async () => {
  for (const values of [
    { ADMIN_TOKEN: "" },
    { OIDC_ISSUER: issuer, ADMIN_TOKEN: "legacy-token" },
    {
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: clientId,
      OIDC_CLIENT_SECRET: "",
      OIDC_ADMIN_SUBJECT: subject,
      APP_ORIGIN: "https://turnstash.test",
    },
  ]) {
    const result = await Effect.runPromise(
      Layer.build(ServerConfigLive).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ DATABASE_URL: "postgres://unused", ...values }),
          ),
        ),
        Effect.result,
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
  }
});
