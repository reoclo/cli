export class ApiError extends Error {
  exitCode = 1;
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
  override exitCode = 3;
  constructor(message: string, path: string) {
    super(401, message, path, "Run 'reoclo login' to refresh your credentials.");
    this.name = "AuthError";
  }
}

export class PermissionError extends ApiError {
  override exitCode = 4;
  constructor(message: string, path: string) {
    super(403, message, path);
    this.name = "PermissionError";
  }
}

export class NotFoundError extends ApiError {
  override exitCode = 5;
  constructor(message: string, path: string) {
    super(404, message, path);
    this.name = "NotFoundError";
  }
}

export class NetworkError extends Error {
  exitCode = 7;
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
