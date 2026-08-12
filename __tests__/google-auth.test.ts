import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGoogleAuthProvider,
  fetchGoogleAccessToken,
  fetchGoogleIdentityToken,
  isGoogleAuth,
  resetGoogleAuthCache,
  resolveGoogleIdentityConfig,
} from "../google-auth.ts";

describe("google-auth", () => {
  const originalEnv = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
  let adcDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adcDir = mkdtempSync(join(tmpdir(), "pi-mcp-google-adc-"));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(adcDir, "adc.json");
    writeFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, JSON.stringify({
      type: "authorized_user",
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
    }));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resetGoogleAuthCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGoogleAuthCache();
    rmSync(adcDir, { recursive: true, force: true });
    if (originalEnv.GOOGLE_APPLICATION_CREDENTIALS === undefined) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = originalEnv.GOOGLE_APPLICATION_CREDENTIALS;
    }
  });

  it("recognizes Google ADC auth modes", () => {
    expect(isGoogleAuth({ auth: "google-access-token" })).toBe(true);
    expect(isGoogleAuth({ auth: "google-identity-token" })).toBe(true);
    expect(isGoogleAuth({ auth: "oauth" })).toBe(false);
    expect(isGoogleAuth({ auth: "bearer" })).toBe(false);
    expect(isGoogleAuth({})).toBe(false);
  });

  it("requires audience and serviceAccount for identity tokens", () => {
    expect(() => resolveGoogleIdentityConfig({}, "iap")).toThrow(/googleAuth.audience/);
    expect(() => resolveGoogleIdentityConfig({
      googleAuth: { audience: "https://iap.example.com", serviceAccount: "" },
    }, "iap")).toThrow(/googleAuth.serviceAccount/);
  });

  it("interpolates identity-token config", () => {
    process.env.IAP_AUDIENCE = "https://iap.example.com";
    process.env.IAP_SA = "sa@example.iam.gserviceaccount.com";
    expect(resolveGoogleIdentityConfig({
      googleAuth: {
        audience: "${IAP_AUDIENCE}",
        serviceAccount: "$env:IAP_SA",
      },
    }, "iap")).toEqual({
      audience: "https://iap.example.com",
      serviceAccount: "sa@example.iam.gserviceaccount.com",
    });
    delete process.env.IAP_AUDIENCE;
    delete process.env.IAP_SA;
  });

  it("exchanges ADC refresh token for an access token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: "ya29.access" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(fetchGoogleAccessToken()).resolves.toBe("ya29.access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("refresh_token=refresh-token");
  });

  it("hints at gcloud login when ADC refresh is rejected", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(fetchGoogleAccessToken()).rejects.toThrow(/gcloud auth login --update-adc/);
  });

  it("rejects unsupported ADC types", async () => {
    writeFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, JSON.stringify({
      type: "service_account",
      client_email: "sa@example.iam.gserviceaccount.com",
    }));

    await expect(fetchGoogleAccessToken()).rejects.toThrow(/Unsupported ADC type/);
  });

  it("rejects a missing ADC file", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(adcDir, "missing.json");
    await expect(fetchGoogleAccessToken()).rejects.toThrow(/Google ADC not found/);
  });

  it("mints an identity token via IAM Credentials", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "ya29.access" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "eyJ.id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await expect(fetchGoogleIdentityToken(
      "sa@example.iam.gserviceaccount.com",
      "https://iap.example.com",
    )).resolves.toBe("eyJ.id");

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain("serviceAccounts/sa@example.iam.gserviceaccount.com:generateIdToken");
    expect(init.headers.Authorization).toBe("Bearer ya29.access");
    expect(JSON.parse(init.body)).toEqual({ audience: "https://iap.example.com", includeEmail: true });
  });

  it("caches provider tokens until expiry and refreshes after 401", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce("token-1")
      .mockResolvedValueOnce("token-2");
    const provider = createGoogleAuthProvider("logging", refresh);

    await expect(provider.token()).resolves.toBe("token-1");
    await expect(provider.token()).resolves.toBe("token-1");
    expect(refresh).toHaveBeenCalledTimes(1);

    await provider.onUnauthorized?.({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL("https://logging.googleapis.com/mcp"),
      fetchFn: fetch,
    });
    await expect(provider.token()).resolves.toBe("token-2");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("uses GOOGLE_APPLICATION_CREDENTIALS over the well-known path", async () => {
    const nested = join(adcDir, "nested");
    mkdirSync(nested);
    const override = join(nested, "other.json");
    writeFileSync(override, JSON.stringify({
      type: "authorized_user",
      client_id: "other-client",
      client_secret: "other-secret",
      refresh_token: "other-refresh",
    }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = override;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: "other-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(fetchGoogleAccessToken()).resolves.toBe("other-token");
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("refresh_token=other-refresh");
  });
});
