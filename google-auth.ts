// google-auth.ts - Google Cloud auth helpers for MCP servers
//
// Supports Application Default Credentials (ADC) from
// `gcloud auth login --update-adc` or GOOGLE_APPLICATION_CREDENTIALS.
// Only authorized_user ADC (user credentials) is supported — service account
// key files are not, by design.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AuthProvider } from "@modelcontextprotocol/client";
import type { ServerEntry } from "./types.ts";
import { interpolateEnvVars } from "./utils.ts";

const WELL_KNOWN_ADC_PATH = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Google access/identity tokens expire in ~60 min; 55-min TTL leaves a margin.
const TOKEN_TTL_MS = 55 * 60 * 1000;

type AuthorizedUserAdc = {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function isGoogleAuth(
  definition: Pick<ServerEntry, "auth">,
): definition is Pick<ServerEntry, "auth"> & { auth: "google-access-token" | "google-identity-token" } {
  return definition.auth === "google-access-token" || definition.auth === "google-identity-token";
}

export function resolveGoogleIdentityConfig(
  definition: Pick<ServerEntry, "googleAuth">,
  serverName: string,
): { audience: string; serviceAccount: string } {
  const audience = definition.googleAuth?.audience
    ? interpolateEnvVars(definition.googleAuth.audience).trim()
    : "";
  const serviceAccount = definition.googleAuth?.serviceAccount
    ? interpolateEnvVars(definition.googleAuth.serviceAccount).trim()
    : "";
  if (!audience) {
    throw new Error(`google-identity-token requires googleAuth.audience for server "${serverName}"`);
  }
  if (!serviceAccount) {
    throw new Error(`google-identity-token requires googleAuth.serviceAccount for server "${serverName}"`);
  }
  return { audience, serviceAccount };
}

function adcPath(): string {
  return process.env.GOOGLE_APPLICATION_CREDENTIALS || WELL_KNOWN_ADC_PATH;
}

function loadAdc(): AuthorizedUserAdc {
  const path = adcPath();
  if (!existsSync(path)) {
    throw new Error(`Google ADC not found.\nRun: gcloud auth login --update-adc`);
  }
  const adc = JSON.parse(readFileSync(path, "utf-8")) as { type?: string };
  if (adc.type !== "authorized_user") {
    throw new Error(`Unsupported ADC type "${adc.type}".\nRun: gcloud auth login --update-adc`);
  }
  return adc as AuthorizedUserAdc;
}

/**
 * Fetch a Google OAuth 2.0 access token via ADC refresh token exchange.
 * Tokens expire in ~60 min; callers should cache with a shorter TTL.
 */
export async function fetchGoogleAccessToken(): Promise<string> {
  const adc = loadAdc();
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: adc.client_id,
      client_secret: adc.client_secret,
      refresh_token: adc.refresh_token,
    }),
  });
  const body = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok) {
    const isAuthError = res.status === 400 || res.status === 401;
    const hint = isAuthError
      ? "Google auth failed — run: gcloud auth login --update-adc"
      : `OAuth token refresh failed (${res.status})`;
    throw new Error(`${hint}: ${body.error_description ?? body.error ?? ""}`);
  }
  if (!body.access_token) {
    throw new Error("OAuth token refresh succeeded but returned no access_token");
  }
  return body.access_token;
}

/**
 * Fetch a Google OIDC identity token for IAP-protected resources.
 *
 * Requires service account impersonation because user ADC credentials cannot
 * produce identity tokens directly. The calling user must have the
 * `roles/iam.serviceAccountTokenCreator` role on the target service account.
 */
export async function fetchGoogleIdentityToken(serviceAccount: string, audience: string): Promise<string> {
  const accessToken = await fetchGoogleAccessToken();
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateIdToken`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ audience, includeEmail: true }),
  });
  const body = await res.json() as { token?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(
      `Failed to generate identity token for "${serviceAccount}" (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`,
    );
  }
  if (!body.token) {
    throw new Error(`Identity token response for "${serviceAccount}" contained no token`);
  }
  return body.token;
}

/**
 * AuthProvider that refreshes Google ADC tokens on demand.
 * Tokens are cached in-process for 55 minutes and dropped on 401.
 */
export function createGoogleAuthProvider(
  serverName: string,
  refreshToken: () => Promise<string>,
): AuthProvider {
  return {
    async token() {
      const cached = tokenCache.get(serverName);
      if (cached && Date.now() < cached.expiresAt) return cached.token;
      const token = await refreshToken();
      tokenCache.set(serverName, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
      return token;
    },
    async onUnauthorized() {
      tokenCache.delete(serverName);
      const token = await refreshToken();
      tokenCache.set(serverName, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    },
  };
}

export function resetGoogleAuthCache(): void {
  tokenCache.clear();
}
