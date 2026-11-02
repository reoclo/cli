import { describe, expect, test } from "bun:test";
import { parseHealthCheck } from "../../../src/util/health-check";

describe("parseHealthCheck", () => {
  test("http:/path sets the type and path", () => {
    expect(parseHealthCheck("http:/healthz")).toEqual({ type: "http", http_path: "/healthz" });
    expect(parseHealthCheck("HTTP:/a/b?x=1")).toEqual({ type: "http", http_path: "/a/b?x=1" });
  });

  test("tcp and none carry no extra fields", () => {
    expect(parseHealthCheck("tcp")).toEqual({ type: "tcp" });
    expect(parseHealthCheck(" none ")).toEqual({ type: "none" });
  });

  test("command:<cmd> keeps the command text", () => {
    expect(parseHealthCheck("command:pg_isready -h localhost")).toEqual({
      type: "command",
      command: "pg_isready -h localhost",
    });
  });

  test("rejects a path without a leading slash or with spaces", () => {
    expect(() => parseHealthCheck("http:health")).toThrow(/must start with \//);
    expect(() => parseHealthCheck("http:/a b")).toThrow(/no spaces/);
    expect(() => parseHealthCheck("http:")).toThrow(/must start with \//);
  });

  test("rejects a bare http or command, an empty command and unknown types", () => {
    expect(() => parseHealthCheck("http")).toThrow(/needs a value/);
    expect(() => parseHealthCheck("command")).toThrow(/needs a value/);
    expect(() => parseHealthCheck("command:  ")).toThrow(/needs a command/);
    expect(() => parseHealthCheck("grpc")).toThrow(/expected http:\/path, tcp/);
  });
});
