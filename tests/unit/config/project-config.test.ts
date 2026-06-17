import { describe, expect, test } from "bun:test";
import {
  findProjectConfigPath,
  projectOrgFor,
  readProjectConfig,
  readProjectOrg,
} from "../../../src/config/project-config";

/** Build an injectable fs from a path→contents map. `.reoclo` files only. */
function fakeFs(files: Record<string, string>) {
  return {
    exists: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return files[p] as string;
    },
  };
}

describe("findProjectConfigPath", () => {
  test("finds a .reoclo in an ancestor directory", () => {
    const fs = fakeFs({ "/a/.reoclo": "{}" });
    expect(findProjectConfigPath("/a/b/c", fs.exists)).toBe("/a/.reoclo");
  });

  test("returns the nearest ancestor when several have .reoclo", () => {
    const fs = fakeFs({ "/a/.reoclo": "{}", "/a/b/.reoclo": "{}" });
    expect(findProjectConfigPath("/a/b/c", fs.exists)).toBe("/a/b/.reoclo");
  });

  test("finds a .reoclo in the start directory itself", () => {
    const fs = fakeFs({ "/a/b/c/.reoclo": "{}" });
    expect(findProjectConfigPath("/a/b/c", fs.exists)).toBe("/a/b/c/.reoclo");
  });

  test("returns null when no .reoclo exists up to the root", () => {
    const fs = fakeFs({});
    expect(findProjectConfigPath("/a/b/c", fs.exists)).toBeNull();
  });
});

describe("readProjectOrg", () => {
  test("returns the org slug from the nearest .reoclo", () => {
    const fs = fakeFs({ "/a/b/.reoclo": '{ "org": "acme" }' });
    expect(readProjectOrg("/a/b/c", fs)).toBe("acme");
  });

  test("nearest ancestor's org wins", () => {
    const fs = fakeFs({
      "/a/.reoclo": '{ "org": "far" }',
      "/a/b/.reoclo": '{ "org": "near" }',
    });
    expect(readProjectOrg("/a/b/c", fs)).toBe("near");
  });

  test("returns null when no .reoclo is found", () => {
    expect(readProjectOrg("/a/b/c", fakeFs({}))).toBeNull();
  });

  test("returns null when the file has no org key", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "other": true }' });
    expect(readProjectOrg("/a/b/c", fs)).toBeNull();
  });

  test("trims surrounding whitespace on the org slug", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "org": "  acme  " }' });
    expect(readProjectOrg("/a/b/c", fs)).toBe("acme");
  });

  test("ignores unknown keys", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "org": "acme", "future": 42 }' });
    expect(readProjectOrg("/a/b/c", fs)).toBe("acme");
  });

  test("throws on malformed JSON", () => {
    const fs = fakeFs({ "/a/.reoclo": "{ not json" });
    expect(() => readProjectOrg("/a/b/c", fs)).toThrow(/\.reoclo/);
  });

  test("throws when org is an empty string", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "org": "   " }' });
    expect(() => readProjectOrg("/a/b/c", fs)).toThrow(/org/);
  });

  test("throws when org is not a string", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "org": 42 }' });
    expect(() => readProjectOrg("/a/b/c", fs)).toThrow(/org/);
  });
});

describe("readProjectConfig", () => {
  test("returns org and profile from the nearest .reoclo", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "org": "acme", "profile": "work" }' });
    expect(readProjectConfig("/a/b/c", fs)).toEqual({ org: "acme", profile: "work" });
  });

  test("returns just the keys that are present", () => {
    expect(readProjectConfig("/a/b", fakeFs({ "/a/.reoclo": '{ "profile": "work" }' }))).toEqual({
      profile: "work",
    });
    expect(readProjectConfig("/a/b", fakeFs({ "/a/.reoclo": '{ "org": "acme" }' }))).toEqual({
      org: "acme",
    });
  });

  test("returns an empty object when the file has no recognized keys", () => {
    expect(readProjectConfig("/a/b", fakeFs({ "/a/.reoclo": '{ "future": 1 }' }))).toEqual({});
  });

  test("returns null when no .reoclo is found", () => {
    expect(readProjectConfig("/a/b/c", fakeFs({}))).toBeNull();
  });

  test("trims org and profile", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "org": " acme ", "profile": " work " }' });
    expect(readProjectConfig("/a/b", fs)).toEqual({ org: "acme", profile: "work" });
  });

  test("throws when profile is an empty string", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "profile": "  " }' });
    expect(() => readProjectConfig("/a/b", fs)).toThrow(/profile/);
  });

  test("throws when profile is not a string", () => {
    const fs = fakeFs({ "/a/.reoclo": '{ "profile": 7 }' });
    expect(() => readProjectConfig("/a/b", fs)).toThrow(/profile/);
  });

  test("throws on malformed JSON", () => {
    expect(() => readProjectConfig("/a/b", fakeFs({ "/a/.reoclo": "{ bad" }))).toThrow(/\.reoclo/);
  });
});

describe("projectOrgFor", () => {
  test("reads and returns the project org for an OAuth profile", () => {
    expect(projectOrgFor("oauth", () => "acme")).toBe("acme");
  });

  test("is undefined for an OAuth profile with no project org", () => {
    expect(projectOrgFor("oauth", () => null)).toBeUndefined();
  });

  test("does NOT read .reoclo for an api-key profile (committed config stays inert)", () => {
    let read = false;
    const result = projectOrgFor("api-key", () => {
      read = true;
      return "acme";
    });
    expect(result).toBeUndefined();
    expect(read).toBe(false);
  });

  test("does NOT read .reoclo under an automation key (no profile) — never throws in CI", () => {
    let read = false;
    const result = projectOrgFor(undefined, () => {
      read = true;
      throw new Error("malformed .reoclo would throw here");
    });
    expect(result).toBeUndefined();
    expect(read).toBe(false);
  });
});
