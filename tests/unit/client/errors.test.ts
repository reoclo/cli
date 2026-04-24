import { expect, test } from "bun:test";
import {
  ApiError,
  AuthError,
  PermissionError,
  NotFoundError,
  NetworkError,
  mapHttpError,
} from "../../../src/client/errors";

test("mapHttpError returns AuthError for 401", () => {
  const e = mapHttpError(401, "Unauthorized", "/auth/me");
  expect(e).toBeInstanceOf(AuthError);
  expect(e.exitCode).toBe(3);
});

test("mapHttpError returns PermissionError for 403", () => {
  const e = mapHttpError(403, "forbidden", "/x");
  expect(e).toBeInstanceOf(PermissionError);
  expect(e.exitCode).toBe(4);
});

test("mapHttpError returns NotFoundError for 404", () => {
  const e = mapHttpError(404, "nope", "/x");
  expect(e).toBeInstanceOf(NotFoundError);
  expect(e.exitCode).toBe(5);
});

test("mapHttpError returns ApiError for other 5xx", () => {
  const e = mapHttpError(500, "server error", "/x");
  expect(e).toBeInstanceOf(ApiError);
  expect(e.exitCode).toBe(1);
});

test("NetworkError exitCode is 7", () => {
  const e = new NetworkError("ECONNREFUSED");
  expect(e.exitCode).toBe(7);
});
