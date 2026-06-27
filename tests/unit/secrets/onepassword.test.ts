import { describe, expect, test } from "bun:test";
import { deriveKey, uniqueKey, mapItemFields } from "../../../src/secrets/sources/onepassword";
import type { OpItem } from "../../../src/secrets/sources/onepassword";

describe("deriveKey", () => {
  test("joins title + label as UPPER_SNAKE", () => {
    expect(deriveKey("My DB", "Connection String")).toBe("MY_DB_CONNECTION_STRING");
  });
  test("collapses runs of non-alphanumerics and strips edges", () => {
    expect(deriveKey("  api / key  ", "")).toBe("API_KEY");
  });
  test("falls back to SECRET when empty", () => {
    expect(deriveKey("", "")).toBe("SECRET");
  });
});

describe("uniqueKey", () => {
  test("suffixes collisions and records each result", () => {
    const used = new Set<string>();
    expect(uniqueKey("K", used)).toBe("K");
    expect(uniqueKey("K", used)).toBe("K_2");
    expect(uniqueKey("K", used)).toBe("K_3");
    expect(used.has("K_3")).toBe(true);
  });
});

describe("mapItemFields", () => {
  test("keeps concealed/text/url; drops OTP, NOTES, empty; keys by title+label", () => {
    const item: OpItem = {
      title: "Prod DB",
      fields: [
        { type: "STRING", purpose: "USERNAME", label: "username", value: "admin" },
        { type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "p@ss" },
        { type: "URL", label: "host", value: "db.example.com" },
        { type: "OTP", label: "one-time password", value: "123456" },
        { type: "STRING", purpose: "NOTES", label: "notesPlain", value: "free text" },
        { type: "STRING", label: "empty", value: "" },
      ],
    };
    expect(mapItemFields(item, new Set<string>())).toEqual([
      { key: "PROD_DB_USERNAME", value: "admin", note: null },
      { key: "PROD_DB_PASSWORD", value: "p@ss", note: null },
      { key: "PROD_DB_HOST", value: "db.example.com", note: null },
    ]);
  });

  test("de-collides keys across items via a shared used-set", () => {
    const used = new Set<string>();
    const a = mapItemFields(
      { title: "AWS", fields: [{ type: "CONCEALED", label: "key", value: "v1" }] },
      used,
    );
    const b = mapItemFields(
      { title: "AWS", fields: [{ type: "CONCEALED", label: "key", value: "v2" }] },
      used,
    );
    expect(a[0]!.key).toBe("AWS_KEY");
    expect(b[0]!.key).toBe("AWS_KEY_2");
  });

  test("ignores non-string field values defensively", () => {
    const item = { title: "X", fields: [{ type: "STRING", label: "n", value: 5 }] } as unknown as OpItem;
    expect(mapItemFields(item, new Set<string>())).toEqual([]);
  });
});
