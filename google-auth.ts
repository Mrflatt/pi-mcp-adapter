// google-auth.ts - Google Cloud auth helpers for MCP servers
//
// Supports Application Default Credentials (ADC) from `gcloud auth login --update-adc`.
// Only authorized_user ADC (user credentials) is supported — service account key files
// are not, by design.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ADC_PATH = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

function loadAdc(): { client_id: string; client_secret: string; refresh_token: string } {
  if (!existsSync(ADC_PATH)) {
    throw new Error(`Google ADC not found.\nRun: gcloud auth login --update-adc`);
  }
  const adc = JSON.parse(readFileSync(ADC_PATH, "utf-8"));
  if (adc.type !== "authorized_user") {
    throw new Error(`Unsupported ADC type "${adc.type}".\nRun: gcloud auth login --update-adc`);
  }
  return adc;
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
  const body = await res.json() as any;
  if (!res.ok) {
    const isAuthError = res.status === 400 || res.status === 401;
    const hint = isAuthError ? "Google auth failed — run: gcloud auth login --update-adc" : `OAuth token refresh failed (${res.status})`;
    throw new Error(`${hint}: ${body.error_description ?? body.error ?? ""}`);
  }
  return body.access_token as string;
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
  const body = await res.json() as any;
  if (!res.ok) {
    throw new Error(
      `Failed to generate identity token for "${serviceAccount}" (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`
    );
  }
  return body.token as string;
}
