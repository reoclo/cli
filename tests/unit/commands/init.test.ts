import { describe, expect, test } from "bun:test";
import {
  buildProjectBinding,
  chooseInitOrg,
  parseHarnessOption,
  parseSkillsOption,
  resolveInitOrgFlag,
} from "../../../src/commands/init";
import type { OrgMembership } from "../../../src/client/types";

describe("parseHarnessOption", () => {
  test("splits and validates a comma list", () => {
    expect(parseHarnessOption("claude,codex")).toEqual(["claude", "codex"]);
    expect(parseHarnessOption("  claude , gemini ")).toEqual(["claude", "gemini"]);
    expect(parseHarnessOption(undefined)).toEqual([]);
  });

  test("drops unknown ids", () => {
    expect(parseHarnessOption("claude,notareal")).toEqual(["claude"]);
  });

  test("an empty string yields no harnesses", () => {
    expect(parseHarnessOption("")).toEqual([]);
    expect(parseHarnessOption(" , ")).toEqual([]);
  });
});

describe("parseSkillsOption", () => {
  test("--no-skills (false) skips", () => {
    expect(parseSkillsOption(false)).toEqual({ skip: true });
  });

  test("absent (undefined) installs all", () => {
    expect(parseSkillsOption(undefined)).toEqual({ skip: false });
  });

  test("the default-true form (no negation) installs all", () => {
    expect(parseSkillsOption(true)).toEqual({ skip: false });
  });

  test("a comma list selects a subset", () => {
    expect(parseSkillsOption("a,b")).toEqual({ skip: false, requested: ["a", "b"] });
  });

  test("trims and drops empty entries in the list", () => {
    expect(parseSkillsOption("a, b ,")).toEqual({ skip: false, requested: ["a", "b"] });
  });
});

describe("buildProjectBinding", () => {
  test("writes only the org (+ version) when resolved under the active profile", () => {
    expect(buildProjectBinding({ org: "acme", profileName: "default", activeProfile: "default" })).toEqual(
      { org: "acme", version: 1 },
    );
  });

  test("records the profile when the org was resolved under a NON-active profile", () => {
    // The org slug is only meaningful relative to its backend, so a project
    // initialized under --profile staging must pin staging or it will silently
    // re-resolve against the active profile later.
    expect(
      buildProjectBinding({ org: "platform", profileName: "staging", activeProfile: "default" }),
    ).toEqual({ profile: "staging", org: "platform", version: 1 });
  });

  test("orders profile before org for readability", () => {
    expect(
      Object.keys(buildProjectBinding({ org: "platform", profileName: "staging", activeProfile: "default" })),
    ).toEqual(["profile", "org", "version"]);
  });

  test("includes the skills block when skills were installed", () => {
    expect(
      buildProjectBinding({
        org: "acme",
        profileName: "default",
        activeProfile: "default",
        skills: { ref: "main", sha: "deadbeef", installed_at: "2026-08-01T00:00:00.000Z" },
      }),
    ).toEqual({
      org: "acme",
      version: 1,
      skills: { ref: "main", sha: "deadbeef", installed_at: "2026-08-01T00:00:00.000Z" },
    });
  });

  test("carries the skills targets and scope through verbatim", () => {
    expect(
      buildProjectBinding({
        org: "acme",
        profileName: "default",
        activeProfile: "default",
        skills: {
          ref: "main",
          sha: "deadbeef",
          installed_at: "2026-08-01T00:00:00.000Z",
          targets: ["claude", "codex"],
          scope: "global",
        },
      }).skills,
    ).toEqual({
      ref: "main",
      sha: "deadbeef",
      installed_at: "2026-08-01T00:00:00.000Z",
      targets: ["claude", "codex"],
      scope: "global",
    });
  });
});

describe("resolveInitOrgFlag", () => {
  test("local --org wins over the global --org", () => {
    expect(resolveInitOrgFlag("local-org", "global-org")).toBe("local-org");
  });

  test("falls back to the global --org when local is unset", () => {
    expect(resolveInitOrgFlag(undefined, "global-org")).toBe("global-org");
  });

  test("a blank local value falls through to the global", () => {
    expect(resolveInitOrgFlag("   ", "global-org")).toBe("global-org");
  });

  test("undefined when neither is set", () => {
    expect(resolveInitOrgFlag(undefined, undefined)).toBeUndefined();
  });

  test("trims the returned value", () => {
    expect(resolveInitOrgFlag("  acme ", undefined)).toBe("acme");
  });
});

const m = (slug: string): OrgMembership => ({
  id: slug,
  tenant_id: `t-${slug}`,
  tenant_slug: slug,
  tenant_name: slug.toUpperCase(),
  role: "tenant_admin",
});

// `init` is the one place a directory gets its org, so the choice must be
// explicit: a flag, the only membership, or a real pick. The login org (the
// first membership at `reoclo login`) is never a default — on a non-TTY that
// used to bind it silently.
describe("chooseInitOrg", () => {
  const never = (): Promise<string> => Promise.reject(new Error("select must not be called"));

  test("--org wins without consulting memberships", async () => {
    expect(await chooseInitOrg({ flagOrg: "beta", memberships: [m("acme"), m("beta")], isTTY: false, select: never })).toBe("beta");
  });

  test("a single membership binds itself", async () => {
    expect(await chooseInitOrg({ memberships: [m("acme")], isTTY: false, select: never })).toBe("acme");
  });

  test("several memberships on a TTY: picks from every org with no login-org bias", async () => {
    let seen: { options: { value: string; label: string }[]; initial: string } | null = null;
    const select = (options: { value: string; label: string }[], initial: string) => {
      seen = { options, initial };
      return Promise.resolve("beta");
    };
    const org = await chooseInitOrg({ memberships: [m("acme"), m("beta")], isTTY: true, select });
    expect(org).toBe("beta");
    expect(seen!.options.map((o) => o.value)).toEqual(["acme", "beta"]);
    expect(seen!.initial).toBe("acme");
  });

  test("several memberships on a non-TTY: exit 4 and name the flag", async () => {
    try {
      await chooseInitOrg({ memberships: [m("acme"), m("beta")], isTTY: false, select: never });
      throw new Error("did not throw");
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(4);
      expect((e as Error).message).toContain("--org");
    }
  });

  test("no memberships: exit 3", async () => {
    try {
      await chooseInitOrg({ memberships: [], isTTY: true, select: never });
      throw new Error("did not throw");
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(3);
    }
  });
});
