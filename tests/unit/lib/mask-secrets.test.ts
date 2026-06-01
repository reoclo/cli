import { describe, expect, test } from "bun:test";
import { SECRET_MASK, maskEnvVars, maskInspectResponse } from "../../../src/lib/mask-secrets";

describe("maskEnvVars", () => {
  test("replaces every value with the mask token but keeps the keys", () => {
    const out = maskEnvVars([
      { key: "MONGODB_URI", value: "mongodb+srv://admin:p@cluster" },
      { key: "AWS_SECRET_ACCESS_KEY", value: "abc123" },
    ]);
    expect(out).toEqual([
      { key: "MONGODB_URI", value: SECRET_MASK },
      { key: "AWS_SECRET_ACCESS_KEY", value: SECRET_MASK },
    ]);
  });

  test("passes through extra fields untouched", () => {
    const out = maskEnvVars([{ key: "X", value: "secret", source: "compose" }]);
    expect(out[0]).toEqual({ key: "X", value: SECRET_MASK, source: "compose" });
  });

  test("does not mutate the input entries", () => {
    const input = [{ key: "X", value: "secret" }];
    maskEnvVars(input);
    expect(input[0]!.value).toBe("secret");
  });

  test("empty array → empty array", () => {
    expect(maskEnvVars([])).toEqual([]);
  });
});

describe("maskInspectResponse", () => {
  const base = (): {
    container_name: string;
    image: string;
    created: string;
    env_vars: Array<{ key: string; value: string }>;
  } => ({
    container_name: "api",
    image: "ghcr.io/acme/api:production",
    created: "2024-01-01T00:00:00Z",
    env_vars: [
      { key: "MONGODB_URI", value: "mongodb+srv://secret" },
      { key: "PORT", value: "8080" },
    ],
  });

  test("masks all env values by default and reports the hidden count", () => {
    const { response, hiddenCount } = maskInspectResponse(base(), false);
    expect(hiddenCount).toBe(2);
    expect(response.env_vars.map((e) => e.value)).toEqual([SECRET_MASK, SECRET_MASK]);
    // non-secret metadata stays visible so staleness (created/image) is usable
    expect(response.image).toBe("ghcr.io/acme/api:production");
    expect(response.created).toBe("2024-01-01T00:00:00Z");
  });

  test("showSecrets=true returns env values unchanged with hiddenCount 0", () => {
    const { response, hiddenCount } = maskInspectResponse(base(), true);
    expect(hiddenCount).toBe(0);
    expect(response.env_vars[0]!.value).toBe("mongodb+srv://secret");
  });

  test("no env vars → hiddenCount 0", () => {
    const { hiddenCount } = maskInspectResponse({ env_vars: [] }, false);
    expect(hiddenCount).toBe(0);
  });

  test("missing env_vars field → hiddenCount 0 and no crash", () => {
    const input: { image: string; env_vars?: Array<{ key: string; value: string }> } = {
      image: "x",
    };
    const { response, hiddenCount } = maskInspectResponse(input, false);
    expect(hiddenCount).toBe(0);
    expect(response.image).toBe("x");
  });

  test("does not mutate the original response", () => {
    const r = { env_vars: [{ key: "X", value: "secret" }] };
    maskInspectResponse(r, false);
    expect(r.env_vars[0]!.value).toBe("secret");
  });
});
