// tests/unit/init/harness.test.ts
import { describe, expect, test } from "bun:test";
import { detectHarnesses, destinationsFor } from "../../../src/init/harness";
import { join } from "node:path";

function probes(present: { paths?: string[]; bins?: string[] }) {
  const paths = new Set(present.paths ?? []);
  const bins = new Set(present.bins ?? []);
  return { exists: (p: string) => paths.has(p), which: (b: string) => bins.has(b) };
}

describe("detectHarnesses", () => {
  test("marks a harness present when its binary is on PATH", () => {
    const got = detectHarnesses("/proj", "/home/u", probes({ bins: ["claude"] }));
    expect(got.find((h) => h.id === "claude")?.present).toBe(true);
    expect(got.find((h) => h.id === "codex")?.present).toBe(false);
  });

  test("marks a harness present when its project marker dir exists", () => {
    const got = detectHarnesses("/proj", "/home/u", probes({ paths: ["/proj/.cursor"] }));
    expect(got.find((h) => h.id === "cursor")?.present).toBe(true);
  });

  test("marks a harness present when its global marker dir exists", () => {
    const got = detectHarnesses("/proj", "/home/u", probes({ paths: ["/home/u/.codex"] }));
    expect(got.find((h) => h.id === "codex")?.present).toBe(true);
  });

  test("returns every known harness exactly once, stable order", () => {
    const got = detectHarnesses("/proj", "/home/u", probes({}));
    expect(got.map((h) => h.id)).toEqual(["claude", "opencode", "codex", "gemini", "cursor"]);
  });
});

describe("destinationsFor", () => {
  test("project scope writes canonical .agents/skills and symlinks Claude", () => {
    const p = destinationsFor(["claude", "codex"], "project", "/proj", "/home/u");
    expect(p.canonicalRoot).toBe(join("/proj", ".agents", "skills"));
    expect(p.symlinkDirs).toEqual([join("/proj", ".claude", "skills")]);
    expect(p.pointerFiles).toEqual([]);
  });

  test("global scope roots everything under home", () => {
    const p = destinationsFor(["claude"], "global", "/proj", "/home/u");
    expect(p.canonicalRoot).toBe(join("/home/u", ".agents", "skills"));
    expect(p.symlinkDirs).toEqual([join("/home/u", ".claude", "skills")]);
  });

  test("non-Claude selection needs no symlink (harness reads .agents/skills)", () => {
    const p = destinationsFor(["codex", "gemini", "opencode"], "project", "/proj", "/home/u");
    expect(p.symlinkDirs).toEqual([]);
    expect(p.canonicalRoot).toBe(join("/proj", ".agents", "skills"));
  });

  test("canonical store is always written even for an empty selection", () => {
    const p = destinationsFor([], "project", "/proj", "/home/u");
    expect(p.canonicalRoot).toBe(join("/proj", ".agents", "skills"));
    expect(p.symlinkDirs).toEqual([]);
  });
});
