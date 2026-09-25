// src/auth/oauth-device.ts
// Pure OAuth 2.1 device-flow helpers (RFC 8628). No side effects beyond fetch.

import { NetworkError } from "../client/errors";
import { sendWithRetry } from "../client/transport";
import { verboseLogger } from "../client/verbose";

export interface DeviceInitResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type?: string;
  expires_in?: number;
}

export class DeviceFlowError extends Error {
  /** Set for transport failures so the top-level handler exits 7 (network). */
  exitCode?: number;
  /** Printed by the top-level handler under the message. */
  hint?: string;
  constructor(
    public code: "expired_token" | "access_denied" | "network",
    message: string,
    /** HTTP status when the failure was a non-2xx response (undefined for
     *  network/transport failures). Lets callers tell a server rejection
     *  (4xx → re-auth) from a transient blip (→ retry). */
    public status?: number,
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/** A DeviceFlowError for a request that got no complete response. Keeps the
 *  network exit code and the transport's hint for the top-level handler. */
function networkFailure(what: string, e: NetworkError): DeviceFlowError {
  const err = new DeviceFlowError("network", `${what}: ${e.message}`);
  err.exitCode = e.exitCode;
  err.hint = e.hint;
  return err;
}

/**
 * POST /oauth/device — initiate the device authorization flow.
 * Returns the device_code, user_code, verification_uri, etc.
 */
export async function initiateDeviceFlow(
  authBaseUrl: string,
  clientId: string,
  scope: string,
  transport: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeviceInitResponse> {
  const url = `${authBaseUrl.replace(/\/$/, "")}/oauth/device`;
  const body = new URLSearchParams({ client_id: clientId, scope });
  // Safe to send again: a lost response leaves at most one unused device code
  // on the server, and it expires on its own.
  let res: Response;
  try {
    res = await sendWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      },
      { retries: 2, sleep: transport.sleep, log: verboseLogger() },
    );
  } catch (e) {
    if (e instanceof NetworkError) {
      throw networkFailure("device login could not start", e);
    }
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new DeviceFlowError("network", `device init failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<DeviceInitResponse>;
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

interface FastAPIWrappedError {
  detail?: TokenErrorBody | string;
}

/**
 * Extract `{error, error_description}` from either an RFC 8628 / RFC 6749
 * body (`{"error": "..."}`) or a FastAPI-wrapped body (`{"detail": {"error": "..."}}`).
 * Production currently emits the wrapped form because OAuth handlers raise
 * `HTTPException(detail={...})`; tolerating both shapes keeps the client
 * working through any server-side migration.
 */
function unwrapTokenError(raw: TokenErrorBody & FastAPIWrappedError): TokenErrorBody {
  if (raw.error) return raw;
  if (raw.detail && typeof raw.detail === "object" && raw.detail.error) {
    return raw.detail;
  }
  return raw;
}

/** Consecutive failed polls (no response) before the login gives up. */
const MAX_FAILED_POLLS = 3;
/** Ceiling for the failure backoff, so scattered failures cannot stretch the
 *  wait past the device code's lifetime. A longer interval set by the server's
 *  slow_down is kept as it is. */
const MAX_BACKOFF_INTERVAL_SEC = 60;

/**
 * POST /oauth/token — poll for the token using device_code grant.
 * Uses form-encoding per RFC 8628 / API spec.
 * Respects slow_down by increasing the interval by 5s.
 * Throws DeviceFlowError on terminal errors (expired_token, access_denied).
 */
export async function pollForToken(
  authBaseUrl: string,
  deviceCode: string,
  clientId: string,
  initialInterval: number,
  options?: {
    onTick?: () => void;
    abortSignal?: AbortSignal;
    /** Wait between polls (injectable for tests). */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<TokenResponse> {
  const url = `${authBaseUrl.replace(/\/$/, "")}/oauth/token`;
  const wait = options?.sleep ?? sleep;
  let intervalSec = initialInterval;
  let failedPolls = 0;

  while (true) {
    if (options?.abortSignal?.aborted) {
      throw new DeviceFlowError("access_denied", "polling aborted");
    }

    await wait(intervalSec * 1000);
    options?.onTick?.();

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientId,
    });

    let res: Response;
    try {
      res = await sendWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: body.toString(),
          signal: options?.abortSignal,
        },
        { retries: 0, log: verboseLogger() },
      );
    } catch (e) {
      if (options?.abortSignal?.aborted) {
        throw new DeviceFlowError("access_denied", "polling aborted");
      }
      if (e instanceof NetworkError) {
        // The next poll is the retry: the loop sends one every interval
        // anyway. Give up only after several failures in a row, so one reset
        // does not end a login the user is approving in the browser. Back off
        // first: RFC 8628 section 3.5 asks clients to poll less often after a
        // connection failure.
        failedPolls++;
        intervalSec = Math.max(intervalSec, Math.min(intervalSec * 2, MAX_BACKOFF_INTERVAL_SEC));
        if (failedPolls < MAX_FAILED_POLLS) continue;
        throw networkFailure("token poll failed", e);
      }
      throw e;
    }
    failedPolls = 0;

    if (res.ok) {
      return res.json() as Promise<TokenResponse>;
    }

    // Parse the RFC 8628 error body. Tolerate FastAPI's `{"detail": {...}}`
    // wrapper for backwards compatibility with older server builds.
    let errBody: TokenErrorBody = {};
    try {
      const raw = (await res.json()) as TokenErrorBody & FastAPIWrappedError;
      errBody = unwrapTokenError(raw);
    } catch {
      // non-JSON error body — treat as network error
      throw new DeviceFlowError("network", `unexpected token poll response (${res.status})`);
    }

    const errorCode = errBody.error ?? "";

    if (errorCode === "authorization_pending") {
      // Keep polling at the current interval
      continue;
    }
    if (errorCode === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (errorCode === "expired_token") {
      throw new DeviceFlowError("expired_token", "device code expired — run login again");
    }
    if (errorCode === "access_denied") {
      throw new DeviceFlowError("access_denied", "authorization cancelled by user");
    }

    // Unknown error
    throw new DeviceFlowError(
      "network",
      `token poll error: ${errorCode || res.status} — ${errBody.error_description ?? ""}`,
    );
  }
}

/**
 * POST /oauth/token — refresh the access token using a refresh_token grant.
 * Uses form-encoding per API spec. Refresh tokens rotate on each use.
 */
export async function refreshAccessToken(
  authBaseUrl: string,
  refreshToken: string,
  clientId: string,
  tenantId?: string,
): Promise<TokenResponse> {
  const url = `${authBaseUrl.replace(/\/$/, "")}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  // State which org this token is for. The server otherwise binds the refreshed
  // token to the FIRST granted tenant, silently undoing `org use <other-org>`.
  // Sent per-request rather than stored server-side so parallel invocations
  // targeting different orgs can't clobber each other.
  if (tenantId) body.set("tenant_id", tenantId);

  // One attempt only (retries: 0). The refresh token rotates, so a blind
  // resend after the server already rotated it trips reuse detection;
  // refreshSession owns the retry policy. The transport still gives --verbose
  // a trace and turns Bun's error into plain words.
  let res: Response;
  try {
    res = await sendWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      },
      { retries: 0, log: verboseLogger() },
    );
  } catch (e) {
    if (e instanceof NetworkError) {
      throw networkFailure("token refresh failed", e);
    }
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new DeviceFlowError("network", `token refresh failed (${res.status}): ${text}`, res.status);
  }
  return res.json() as Promise<TokenResponse>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
