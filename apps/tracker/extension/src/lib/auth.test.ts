import { afterEach, expect, spyOn, test } from "bun:test";

import { fakeBrowser } from "@webext-core/fake-browser";

import { defaultSettings } from "./settings.ts";

Object.assign(globalThis, { chrome: fakeBrowser, browser: fakeBrowser });
const { bearer } = await import("./auth.ts");
const { authTokensStore, settingsStore } = await import("./storage.ts");

const issuer = "https://auth.example.org/application/o/tracker/";

// Bun has no Web Locks; this one grants each lock name to one holder at a time.
let held: Promise<unknown> = Promise.resolve();
Object.defineProperty(navigator, "locks", {
  configurable: true,
  value: {
    request<T>(_name: string, granted: () => Promise<T>): Promise<T> {
      const turn = held.then(granted);
      held = turn.catch(() => undefined);
      return turn;
    },
  },
});

const fetchRequest = spyOn(globalThis, "fetch");

afterEach(() => {
  fakeBrowser.reset();
  fetchRequest.mockReset();
});

// authentik's default: every refresh rotates the refresh token and revokes the
// one it was traded for.
function rotatingIssuer() {
  let current = "r1";
  let issued = 1;
  const respond = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(input instanceof Request ? input.url : input);
    if (pathname.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}authorize/`,
        token_endpoint: `${issuer}token/`,
      });
    }
    const sent = init?.body instanceof URLSearchParams ? init.body.get("refresh_token") : null;
    if (sent !== current) return Response.json({ error: "invalid_grant" }, { status: 400 });
    issued += 1;
    current = `r${issued}`;
    return Response.json({
      access_token: `a${issued}`,
      token_type: "Bearer",
      expires_in: 300,
      refresh_token: current,
    });
  };
  fetchRequest.mockImplementation(Object.assign(respond, { preconnect: fetch.preconnect }));
  return { current: () => current };
}

test("callers that find the token expired at once all get one and keep the session", async () => {
  await settingsStore.set({ ...defaultSettings, oidcIssuer: issuer, oidcClientId: "tracker" });
  await authTokensStore.set({ accessToken: "a1", expiresAt: Date.now() - 1, refreshToken: "r1" });
  const provider = rotatingIssuer();

  const results = await Promise.all([bearer(), bearer(), bearer()]);

  expect(results.every((result) => result.ok)).toBe(true);
  expect((await authTokensStore.get())?.refreshToken).toBe(provider.current());
});
