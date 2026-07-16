import { EXIT } from "./exit-codes";

export class ApiError extends Error {
  exitCode: number = EXIT.GENERIC;
  constructor(
    public status: number,
    message: string,
    public path: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthError extends ApiError {
  override exitCode: number = EXIT.AUTH;
  constructor(message: string, path: string) {
    super(401, message, path, "Run 'reoclo login' to refresh your credentials.");
    this.name = "AuthError";
  }
}

/** HTTP 403 — authenticated, but not permitted. Note this is DENIED (4), not
 *  AUTH (3): 3 means "we don't know who you are", 4 means "we know, and no". */
export class PermissionError extends ApiError {
  override exitCode: number = EXIT.DENIED;
  constructor(message: string, path: string) {
    super(403, message, path);
    this.name = "PermissionError";
  }
}

export class NotFoundError extends ApiError {
  override exitCode: number = EXIT.NOT_FOUND;
  constructor(message: string, path: string) {
    super(404, message, path);
    this.name = "NotFoundError";
  }
}

/**
 * Raised when a 401 cannot be recovered by refreshing — either there is no
 * stored refresh token (`missing`) or the auth server rejected it (`rejected`,
 * e.g. expired / revoked / reuse-detected). Carries a profile-specific,
 * actionable message so the user knows exactly which `reoclo login` to run,
 * instead of the generic "Invalid or expired token". exitCode 3 matches the
 * other auth failures.
 */
export class ReauthRequiredError extends ApiError {
  override exitCode: number = EXIT.AUTH;
  constructor(profile: string, kind: "missing" | "rejected") {
    const message =
      kind === "missing"
        ? `no stored session to refresh for profile '${profile}'`
        : `session for profile '${profile}' could not be refreshed — the refresh token was rejected (it may be expired or revoked)`;
    const verb = kind === "missing" ? "sign in" : "re-authenticate";
    super(401, message, "", `Run 'reoclo login --profile ${profile}' to ${verb}.`);
    this.name = "ReauthRequiredError";
  }
}

export class NetworkError extends Error {
  exitCode: number = EXIT.NETWORK;
  constructor(
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

/** Try to pull `detail` out of a FastAPI error body. Returns the trimmed
 *  string if found, or the original input. Lets the CLI render
 *  `Error: not found` instead of `Error: {"detail":"Not Found"}`. */
function unwrapDetail(message: string): string {
  const trimmed = (message ?? "").trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // not JSON, fall through
  }
  return trimmed;
}

export function mapHttpError(status: number, message: string, path: string): ApiError {
  const detail = unwrapDetail(message);
  if (status === 401) return new AuthError(detail, path);
  if (status === 403) return new PermissionError(detail, path);
  if (status === 404) {
    // Friendlier 404 with the requested path so users can see what failed.
    const friendly = detail.toLowerCase() === "not found" ? `not found: ${path}` : detail;
    return new NotFoundError(friendly, path);
  }
  return new ApiError(status, detail, path);
}
