// src/auth/renew.ts
//
// Pure helpers shared by the shell and tunnel WS clients for negotiating and
// adopting a server-issued token renewal mid-session.

/**
 * The WS subprotocol a client advertises to tell the gateway it understands
 * `token_renew` control frames. Sent alongside the auth subprotocol; the
 * gateway only pushes renewals to clients that asked for them.
 */
export const RENEW_SUBPROTOCOL = "reoclo.renew.v1";

/**
 * Decode a JWT's `exp` claim (seconds since epoch) without verifying the
 * signature — this is a client-side hint for renewal timing, not an auth
 * decision. Any malformed input (wrong segment count, bad base64url, invalid
 * JSON, non-numeric `exp`) returns undefined rather than throwing.
 */
export function jwtExp(token: string): number | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = parts[1];
    if (!payload) return undefined;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp : undefined;
  } catch {
    return undefined;
  }
}
