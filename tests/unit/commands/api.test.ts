import { describe, expect, test } from "bun:test";
import { buildApiRequest, typedFieldValue } from "../../../src/commands/api";

const TID = "019d3150-0c81-75f1-9c3d-78829636257a";

describe("typedFieldValue", () => {
  test("JSON literals keep their type", () => {
    expect(typedFieldValue("true")).toBe(true);
    expect(typedFieldValue("false")).toBe(false);
    expect(typedFieldValue("null")).toBeNull();
  });

  test("numbers keep their type", () => {
    expect(typedFieldValue("42")).toBe(42);
    expect(typedFieldValue("-3.5")).toBe(-3.5);
  });

  test("everything else stays a string", () => {
    expect(typedFieldValue("hello")).toBe("hello");
    expect(typedFieldValue("")).toBe("");
    expect(typedFieldValue("12abc")).toBe("12abc");
  });
});

describe("buildApiRequest", () => {
  test("defaults to GET with a normalized leading slash", () => {
    const r = buildApiRequest({ path: "tenants/x/servers/" });
    expect(r.method).toBe("GET");
    expect(r.path).toBe("/tenants/x/servers/");
    expect(r.body).toBeUndefined();
  });

  test("expands {tenant} everywhere in the path", () => {
    const r = buildApiRequest({
      path: "/tenants/{tenant}/application-groups/",
      tenantId: TID,
    });
    expect(r.path).toBe(`/tenants/${TID}/application-groups/`);
  });

  test("rejects {tenant} without a tenant id", () => {
    expect(() => buildApiRequest({ path: "/tenants/{tenant}/servers/" })).toThrow(
      /no organization/,
    );
  });

  test("appends query params with ? then &, encoded", () => {
    const r = buildApiRequest({
      path: "/deployments?limit=5",
      query: ["status=failed", "commit ref=main/x"],
    });
    expect(r.path).toBe("/deployments?limit=5&status=failed&commit%20ref=main%2Fx");
  });

  test("fields build a typed JSON body and default the method to POST", () => {
    const r = buildApiRequest({
      path: "/x",
      fields: ["count=3", "enabled=true"],
      rawFields: ["version=42"],
    });
    expect(r.method).toBe("POST");
    expect(r.body).toEqual({ count: 3, enabled: true, version: "42" });
  });

  test("--data parses raw JSON and explicit method wins", () => {
    const r = buildApiRequest({ path: "/x", method: "put", data: '{"a":[1,2]}' });
    expect(r.method).toBe("PUT");
    expect(r.body).toEqual({ a: [1, 2] });
  });

  test("rejects --data combined with fields", () => {
    expect(() => buildApiRequest({ path: "/x", data: "{}", fields: ["a=1"] })).toThrow(
      /cannot be combined/,
    );
  });

  test("rejects invalid JSON in --data", () => {
    expect(() => buildApiRequest({ path: "/x", data: "{nope" })).toThrow(/not valid JSON/);
  });

  test("rejects a body on GET and DELETE", () => {
    expect(() => buildApiRequest({ path: "/x", method: "GET", fields: ["a=1"] })).toThrow(
      /cannot carry a body/,
    );
    expect(() => buildApiRequest({ path: "/x", method: "DELETE", data: "{}" })).toThrow(
      /cannot carry a body/,
    );
  });

  test("rejects unsupported methods and malformed pairs", () => {
    expect(() => buildApiRequest({ path: "/x", method: "TRACE" })).toThrow(
      /unsupported method/,
    );
    expect(() => buildApiRequest({ path: "/x", query: ["noequals"] })).toThrow(/key=value/);
    expect(() => buildApiRequest({ path: "/x", fields: ["=v"] })).toThrow(/key=value/);
  });
});
