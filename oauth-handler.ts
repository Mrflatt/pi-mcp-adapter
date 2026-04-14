// oauth-handler.ts - OAuth token management for MCP servers
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getAuthEntryFilePath } from "./mcp-auth.ts";

// Google auth tokens expire in 60 min; 55-min TTL gives a 5-min safety margin
const GOOGLE_TOKEN_TTL_MS = 55 * 60 * 1000;

// Token storage path for a server
function getTokensPath(serverName: string): string {
  return getAuthEntryFilePath(serverName);
}

/**
 * Get stored OAuth tokens for a server (if any).
 * Returns undefined if no tokens or tokens are expired.
 * 
 * Token file location: $MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json when set,
 * otherwise <Pi agent dir>/mcp-oauth/sha256-<server-hash>/tokens.json
 * 
 * Expected format:
 * {
 *   "access_token": "...",
 *   "token_type": "bearer",
 *   "refresh_token": "...",  // optional
 *   "expires_in": 3600,      // optional, seconds
 *   "expiresAt": 1234567890  // optional, absolute timestamp ms
 * }
 */
export function getStoredTokens(serverName: string): OAuthTokens | undefined {
  const tokensPath = getTokensPath(serverName);
  
  if (!existsSync(tokensPath)) return undefined;
  
  try {
    const stored = JSON.parse(readFileSync(tokensPath, "utf-8"));
    
    // Validate required field
    if (!stored.access_token || typeof stored.access_token !== "string") {
      return undefined;
    }
    
    // Check expiration if expiresAt is set
    if (stored.expiresAt && typeof stored.expiresAt === "number") {
      if (Date.now() > stored.expiresAt) {
        // Token expired
        return undefined;
      }
    }
    
    return {
      access_token: stored.access_token,
      token_type: stored.token_type ?? "bearer",
      refresh_token: stored.refresh_token,
      expires_in: stored.expires_in,
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist a Google auth token with a 55-min TTL.
 * Used by google-access-token and google-identity-token auth modes.
 */
export function writeStoredToken(serverName: string, accessToken: string): void {
  const tokensPath = getTokensPath(serverName);
  mkdirSync(dirname(tokensPath), { recursive: true });
  writeFileSync(tokensPath, JSON.stringify({
    access_token: accessToken,
    token_type: "bearer",
    expiresAt: Date.now() + GOOGLE_TOKEN_TTL_MS,
  }, null, 2));
}

/**
 * Remove the cached token for a server.
 * Call this when the server returns 401 so the next connect fetches a fresh token
 * rather than retrying with a revoked one.
 */
export function clearStoredTokens(serverName: string): void {
  const tokensPath = getTokensPath(serverName);
  if (existsSync(tokensPath)) {
    try { unlinkSync(tokensPath); } catch { /* ignore */ }
  }
}
