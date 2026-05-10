// src/auth/oauth-device.ts
// Pure OAuth 2.1 device-flow helpers (RFC 8628). No side effects beyond fetch.

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
  constructor(
    public code: "expired_token" | "access_denied" | "network",
    message: string,
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/**
 * POST /oauth/device — initiate the device authorization flow.
 * Returns the device_code, user_code, verification_uri, etc.
 */
export async function initiateDeviceFlow(
  authBaseUrl: string,
  clientId: string,
  scope: string,
): Promise<DeviceInitResponse> {
  const url = `${authBaseUrl.replace(/\/$/, "")}/oauth/device`;
  const body = new URLSearchParams({ client_id: clientId, scope });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (e) {
    throw new DeviceFlowError("network", `network error during device init: ${(e as Error).message}`);
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
  options?: { onTick?: () => void; abortSignal?: AbortSignal },
): Promise<TokenResponse> {
  const url = `${authBaseUrl.replace(/\/$/, "")}/oauth/token`;
  let intervalSec = initialInterval;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (options?.abortSignal?.aborted) {
      throw new DeviceFlowError("access_denied", "polling aborted");
    }

    await sleep(intervalSec * 1000);
    options?.onTick?.();

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientId,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: options?.abortSignal,
      });
    } catch (e) {
      if (options?.abortSignal?.aborted) {
        throw new DeviceFlowError("access_denied", "polling aborted");
      }
      throw new DeviceFlowError("network", `network error during token poll: ${(e as Error).message}`);
    }

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
): Promise<TokenResponse> {
  const url = `${authBaseUrl.replace(/\/$/, "")}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (e) {
    throw new DeviceFlowError("network", `network error during token refresh: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new DeviceFlowError("network", `token refresh failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<TokenResponse>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
