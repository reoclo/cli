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

export function mapHttpError(status: number, message: string, path: string): ApiError {
  if (status === 401) return new AuthError(message, path);
  if (status === 403) return new PermissionError(message, path);
  if (status === 404) return new NotFoundError(message, path);
  return new ApiError(status, message, path);
}
