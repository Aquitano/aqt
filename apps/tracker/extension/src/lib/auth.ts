import * as oauth from "oauth4webapi";
import { browser } from "wxt/browser";

import { errorMessage } from "./errors.ts";
import type { Result } from "./result.ts";
import type { Settings } from "./settings.ts";
import { authTokensStore, loadSettings } from "./storage.ts";

// Refresh a little before expiry so a request in flight never carries a token
// that dies on the way.
const EXPIRY_SKEW_MS = 60_000;
const FALLBACK_LIFETIME_S = 300;

// "off" is an issuer that was never configured, which is what loopback runs
// on; "out" means an issuer is configured and there is no usable token.
export type AuthState = "off" | "in" | "out";

export function redirectUri(): string {
  return browser.identity.getRedirectURL();
}

function configured(settings: Settings): { issuer: string; clientId: string } | undefined {
  const { oidcIssuer, oidcClientId } = settings;
  return oidcIssuer && oidcClientId ? { issuer: oidcIssuer, clientId: oidcClientId } : undefined;
}

export async function authState(): Promise<AuthState> {
  const settings = await loadSettings();
  if (!configured(settings)) return "off";
  const tokens = await authTokensStore.get();
  if (!tokens) return "out";
  // A provider that granted no refresh token leaves nothing to renew with, so
  // once the access token is spent this is signed out however new it looks.
  return tokens.refreshToken || Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS ? "in" : "out";
}

async function authorizationServer(issuer: string): Promise<oauth.AuthorizationServer> {
  const url = new URL(issuer);
  return oauth.processDiscoveryResponse(
    url,
    await oauth.discoveryRequest(url, { algorithm: "oidc" }),
  );
}

async function persist(response: oauth.TokenEndpointResponse, previousRefresh?: string) {
  await authTokensStore.set({
    accessToken: response.access_token,
    expiresAt: Date.now() + (response.expires_in ?? FALLBACK_LIFETIME_S) * 1000,
    // A provider that rotates refresh tokens returns a new one; one that does
    // not returns none, and the old one stays good.
    refreshToken: response.refresh_token ?? previousRefresh,
  });
}

export async function signIn(): Promise<Result<undefined>> {
  const settings = await loadSettings();
  const client = configured(settings);
  if (!client) return { ok: false, error: "set an OIDC issuer and client id first" };
  try {
    const as = await authorizationServer(client.issuer);
    if (!as.authorization_endpoint) {
      return { ok: false, error: `${client.issuer} publishes no authorization_endpoint` };
    }
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const redirect = redirectUri();
    const authorize = new URL(as.authorization_endpoint);
    authorize.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid profile email offline_access",
      code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
    }).toString();

    const returned = await browser.identity.launchWebAuthFlow({
      url: authorize.href,
      interactive: true,
    });
    if (!returned) return { ok: false, error: "sign in was cancelled" };

    const params = oauth.validateAuthResponse(
      as,
      { client_id: client.clientId },
      new URL(returned),
      state,
    );
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      { client_id: client.clientId },
      oauth.None(),
      params,
      redirect,
      codeVerifier,
    );
    await persist(
      await oauth.processAuthorizationCodeResponse(as, { client_id: client.clientId }, response),
    );
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function signOut(): Promise<void> {
  await authTokensStore.remove();
}

// refresh trades the stored refresh token for a new access token. Only a
// definitive invalid_grant clears the session: a network blip must not look
// like a logout, or an offline laptop signs itself out.
export async function refresh(): Promise<Result<string | undefined>> {
  const settings = await loadSettings();
  const client = configured(settings);
  if (!client) return { ok: true, value: undefined };
  const tokens = await authTokensStore.get();
  if (!tokens?.refreshToken) return { ok: false, error: "signed out: open options and sign in" };
  try {
    const as = await authorizationServer(client.issuer);
    const response = await oauth.processRefreshTokenResponse(
      as,
      { client_id: client.clientId },
      await oauth.refreshTokenGrantRequest(
        as,
        { client_id: client.clientId },
        oauth.None(),
        tokens.refreshToken,
      ),
    );
    await persist(response, tokens.refreshToken);
    return { ok: true, value: response.access_token };
  } catch (error) {
    if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
      await authTokensStore.remove();
      return { ok: false, error: "session expired: open options and sign in" };
    }
    return { ok: false, error: `token refresh: ${errorMessage(error)}` };
  }
}

// bearer is undefined when no issuer is configured, which is how every
// request stays unauthenticated on loopback.
export async function bearer(): Promise<Result<string | undefined>> {
  const settings = await loadSettings();
  if (!configured(settings)) return { ok: true, value: undefined };
  const tokens = await authTokensStore.get();
  if (!tokens) return { ok: false, error: "signed out: open options and sign in" };
  if (Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
    return { ok: true, value: tokens.accessToken };
  }
  return refresh();
}
