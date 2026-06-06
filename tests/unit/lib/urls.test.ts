import { describe, expect, test } from "bun:test";
import { canonicalApiUrl, canonicalStreamsUrl } from "../../../src/lib/urls";

describe("canonical URLs (override-independent)", () => {
  test("canonicalApiUrl returns the root-domain api host", () => {
    expect(canonicalApiUrl()).toBe("https://api.reoclo.com");
  });

  test("canonicalStreamsUrl returns the root-domain streams host", () => {
    expect(canonicalStreamsUrl()).toBe("https://streams.reoclo.com");
  });

  test("canonicalApiUrl ignores the REOCLO_API_URL per-invocation override", () => {
    const saved = process.env.REOCLO_API_URL;
    process.env.REOCLO_API_URL = "https://api.staging-override.example";
    try {
      expect(canonicalApiUrl()).toBe("https://api.reoclo.com");
    } finally {
      if (saved === undefined) delete process.env.REOCLO_API_URL;
      else process.env.REOCLO_API_URL = saved;
    }
  });

  test("canonicalStreamsUrl ignores the REOCLO_STREAMS_URL per-invocation override", () => {
    const saved = process.env.REOCLO_STREAMS_URL;
    process.env.REOCLO_STREAMS_URL = "https://streams.staging-override.example";
    try {
      expect(canonicalStreamsUrl()).toBe("https://streams.reoclo.com");
    } finally {
      if (saved === undefined) delete process.env.REOCLO_STREAMS_URL;
      else process.env.REOCLO_STREAMS_URL = saved;
    }
  });
});
