# CLI Login — Profile-Active Handling, Feedback & Prettified Roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `reoclo login`'s effect on the global active profile predictable (never leaks across shells), show the resolved profile + its source + a prettified role in login feedback, and humanize roles wherever they're shown to a person.

**Architecture:** Drop the implicit `active_profile` mutation from `saveProfile` (pure write), and move the active-profile decision explicitly into `login` via a pure `shouldSetActiveProfile` helper (Option A: scoped logins don't mutate global active unless it's the first profile). Add a source-aware profile resolver and a pure `formatLoginSummary` for feedback. Add one shared `formatRole` humanizer used by login feedback, `whoami`, and `org ls` (text mode only).

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:test`), commander.

**Spec:** `docs/superpowers/specs/2026-06-04-cli-login-profile-active-and-feedback-design.md`

**Conventions:** Tests live under `cli/tests/unit/...`, use `import { describe, expect, test } from "bun:test"`. Run a single file with `bun test <path>`. All commands below run from the `cli/` submodule root (branch `fix/cli-login-profile-active`). Commit messages use conventional commits; **no Claude attribution.**

---

## File Structure

**New files:**
- `src/ui/format-role.ts` — `formatRole(role)` humanizer (display-only).
- `src/commands/login-summary.ts` — `shouldSetActiveProfile`, `LoginSummaryInput`, `formatLoginSummary` (pure, network-free).
- `tests/unit/ui/format-role.test.ts`
- `tests/unit/commands/login-summary.test.ts`
- `tests/unit/commands/org-rows.test.ts`

**Modified files:**
- `src/config/store.ts` — `saveProfile` no longer mutates `active_profile`.
- `src/config/profile-resolve.ts` — add `ProfileSource` + `resolveCommandProfileWithSource`; `resolveCommandProfile` becomes a thin wrapper.
- `src/commands/login.ts` — source-aware resolve, capture `hadNoProfiles`, explicit `setActiveProfile`, `formatLoginSummary` output; `LoginFlowOptions.source`.
- `src/commands/whoami.ts` — prettify membership role.
- `src/commands/org.ts` — extract `buildOrgRows`, prettify role in text mode only.
- `tests/unit/config/store.test.ts` — regression test for the removed flip.
- `tests/unit/config/profile-resolve.test.ts` — tests for `resolveCommandProfileWithSource`.
- `tests/unit/commands/login.test.ts` — assert the resolved `source`.

---

### Task 1: `formatRole` humanizer

**Files:**
- Create: `src/ui/format-role.ts`
- Test: `tests/unit/ui/format-role.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ui/format-role.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatRole } from "../../../src/ui/format-role";

describe("formatRole", () => {
  test("humanizes snake_case", () => {
    expect(formatRole("tenant_admin")).toBe("Tenant Admin");
  });
  test("humanizes super_admin", () => {
    expect(formatRole("super_admin")).toBe("Super Admin");
  });
  test("title-cases a single word", () => {
    expect(formatRole("viewer")).toBe("Viewer");
  });
  test("handles dashes", () => {
    expect(formatRole("read-only")).toBe("Read Only");
  });
  test("collapses repeated separators and trims", () => {
    expect(formatRole("  deployer__bot ")).toBe("Deployer Bot");
  });
  test("title-cases already-spaced input", () => {
    expect(formatRole("tenant admin")).toBe("Tenant Admin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/ui/format-role.test.ts`
Expected: FAIL — cannot resolve module `../../../src/ui/format-role`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/format-role.ts`:

```ts
// src/ui/format-role.ts
//
// Humanize server role strings (snake_case / kebab-case) for display. Mirrors
// the web humanizer in auth/src/lib/oauth-client.ts:formatRole so the CLI and
// console render roles the same way. Display-only — never feed the result back
// to the API.
export function formatRole(role: string): string {
  return role
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/ui/format-role.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/format-role.ts tests/unit/ui/format-role.test.ts
git commit -m "feat(cli): add formatRole role humanizer for display"
```

---

### Task 2: `saveProfile` becomes a pure write (remove implicit active-profile flip)

**Files:**
- Modify: `src/config/store.ts:71-76`
- Test: `tests/unit/config/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/config/store.test.ts` (the helper `makeTmp` and imports already exist in the file):

```ts
test("saveProfile does not move active_profile (no implicit flip)", async () => {
  const tmp = makeTmp();
  // active_profile starts at the EMPTY default "default".
  await withConfigDir(tmp, () =>
    saveProfile("default", {
      api_url: "x", token: "t1", tenant_id: "t", tenant_slug: "s",
      user_email: "e", token_type: "tenant", saved_at: "now",
    }),
  );
  // Saving a DIFFERENT profile must NOT flip active_profile to it.
  await withConfigDir(tmp, () =>
    saveProfile("work", {
      api_url: "x", token: "t2", tenant_id: "t", tenant_slug: "s",
      user_email: "e", token_type: "tenant", saved_at: "now",
    }),
  );
  const cfg = await withConfigDir(tmp, () => loadConfig());
  expect(cfg.active_profile).toBe("default");
  expect(Object.keys(cfg.profiles).sort()).toEqual(["default", "work"]);
});
```

Also add `withConfigDir` to the existing import from `../../../src/config/paths` if not already present — it is already imported at the top of the file (`import { withConfigDir } from "../../../src/config/paths";`), so no import change is needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/config/store.test.ts`
Expected: FAIL — the new test reports `active_profile` is `"work"` (the old flip fires because current active is `"default"`).

- [ ] **Step 3: Write minimal implementation**

In `src/config/store.ts`, remove the implicit flip line from `saveProfile`. Replace:

```ts
export async function saveProfile(name: string, profile: ProfileRecord): Promise<void> {
  const cfg = await loadConfig();
  cfg.profiles[name] = profile;
  if (!cfg.active_profile || cfg.active_profile === "default") cfg.active_profile = name;
  await writeConfig(cfg);
}
```

with:

```ts
// Pure profile write. Setting which profile is *active* is an explicit decision
// owned by `reoclo login` (and `reoclo profile use`) — NOT a side effect of any
// write. Token persistence (FileStore.set) and refresh (bootstrap onExpiry) also
// route through here; they must never change the active profile.
export async function saveProfile(name: string, profile: ProfileRecord): Promise<void> {
  const cfg = await loadConfig();
  cfg.profiles[name] = profile;
  await writeConfig(cfg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/config/store.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add src/config/store.ts tests/unit/config/store.test.ts
git commit -m "fix(cli): saveProfile no longer mutates active_profile (kills cross-shell flip)"
```

---

### Task 3: Source-aware profile resolution

**Files:**
- Modify: `src/config/profile-resolve.ts` (add after `resolveCommandProfile`, then rewrite `resolveCommandProfile` as a wrapper)
- Test: `tests/unit/config/profile-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new describe block to `tests/unit/config/profile-resolve.test.ts`. Add `resolveCommandProfileWithSource` to the existing top import from `../../../src/config/profile-resolve`:

```ts
describe("resolveCommandProfileWithSource", () => {
  const cmd = (profile?: string) => ({ optsWithGlobals: () => ({ profile }) });
  function withEnv(value: string | undefined, fn: () => void): void {
    const saved = process.env.REOCLO_PROFILE;
    if (value === undefined) delete process.env.REOCLO_PROFILE;
    else process.env.REOCLO_PROFILE = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.REOCLO_PROFILE;
      else process.env.REOCLO_PROFILE = saved;
    }
  }

  test("flag → source 'flag'", () => {
    withEnv(undefined, () => {
      expect(resolveCommandProfileWithSource(cmd("staging"), "default")).toEqual({
        name: "staging",
        source: "flag",
      });
    });
  });
  test("env → source 'env'", () => {
    withEnv("work", () => {
      expect(resolveCommandProfileWithSource(cmd(undefined), "default")).toEqual({
        name: "work",
        source: "env",
      });
    });
  });
  test("flag beats env", () => {
    withEnv("work", () => {
      expect(resolveCommandProfileWithSource(cmd("staging"), "default")).toEqual({
        name: "staging",
        source: "flag",
      });
    });
  });
  test("blank/whitespace env → fallback with source 'default'", () => {
    withEnv("   ", () => {
      expect(resolveCommandProfileWithSource(cmd(undefined), "default")).toEqual({
        name: "default",
        source: "default",
      });
    });
  });
  test("unset env, no flag → fallback with source 'default'", () => {
    withEnv(undefined, () => {
      expect(resolveCommandProfileWithSource(cmd(undefined), "default")).toEqual({
        name: "default",
        source: "default",
      });
    });
  });
  test("trims a whitespace-padded flag", () => {
    withEnv(undefined, () => {
      expect(resolveCommandProfileWithSource(cmd(" staging "), "default")).toEqual({
        name: "staging",
        source: "flag",
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/config/profile-resolve.test.ts`
Expected: FAIL — `resolveCommandProfileWithSource` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/config/profile-resolve.ts`, add the type + function, and rewrite `resolveCommandProfile` to delegate. Replace the existing `resolveCommandProfile` definition:

```ts
export function resolveCommandProfile(command: GlobalOptsCommand, fallback: string): string {
  return resolveProfileName({
    flagProfile: globalProfileFlag(command),
    envProfile: process.env.REOCLO_PROFILE,
    activeProfile: fallback,
  });
}
```

with:

```ts
/** Where a resolved profile name came from. */
export type ProfileSource = "flag" | "env" | "default";

/**
 * Like resolveCommandProfile, but also reports WHERE the name came from:
 * `--profile` flag → `flag`, `$REOCLO_PROFILE` → `env`, else the `fallback`
 * → `default`. Precedence and empty/whitespace handling match
 * resolveCommandProfile exactly (blank/unset flag and env are treated as
 * unset). `login` uses the source to decide whether to touch the global
 * active profile and to annotate its feedback.
 */
export function resolveCommandProfileWithSource(
  command: GlobalOptsCommand,
  fallback: string,
): { name: string; source: ProfileSource } {
  const flag = pick(globalProfileFlag(command));
  if (flag) return { name: flag, source: "flag" };
  const env = pick(process.env.REOCLO_PROFILE);
  if (env) return { name: env, source: "env" };
  return { name: fallback, source: "default" };
}

export function resolveCommandProfile(command: GlobalOptsCommand, fallback: string): string {
  return resolveCommandProfileWithSource(command, fallback).name;
}
```

(`pick` is already defined at the bottom of this module and trims/blank-checks; `globalProfileFlag` already returns a non-empty string or undefined.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/config/profile-resolve.test.ts`
Expected: PASS — the new describe block plus all pre-existing `resolveCommandProfile` tests (which now exercise the wrapper) stay green.

- [ ] **Step 5: Commit**

```bash
git add src/config/profile-resolve.ts tests/unit/config/profile-resolve.test.ts
git commit -m "feat(cli): add resolveCommandProfileWithSource (reports flag/env/default origin)"
```

---

### Task 4: Login decision + feedback helpers

**Files:**
- Create: `src/commands/login-summary.ts`
- Test: `tests/unit/commands/login-summary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/commands/login-summary.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  shouldSetActiveProfile,
  formatLoginSummary,
  type LoginSummaryInput,
} from "../../../src/commands/login-summary";

describe("shouldSetActiveProfile", () => {
  test("first profile on the machine → true regardless of source", () => {
    expect(shouldSetActiveProfile({ hadNoProfiles: true, source: "env" })).toBe(true);
    expect(shouldSetActiveProfile({ hadNoProfiles: true, source: "flag" })).toBe(true);
    expect(shouldSetActiveProfile({ hadNoProfiles: true, source: "default" })).toBe(true);
  });
  test("bare login (source default) → true", () => {
    expect(shouldSetActiveProfile({ hadNoProfiles: false, source: "default" })).toBe(true);
  });
  test("scoped login with existing profiles → false", () => {
    expect(shouldSetActiveProfile({ hadNoProfiles: false, source: "env" })).toBe(false);
    expect(shouldSetActiveProfile({ hadNoProfiles: false, source: "flag" })).toBe(false);
  });
});

describe("formatLoginSummary", () => {
  const base: LoginSummaryInput = {
    email: "david@goflowstate.com",
    org: "acme",
    roles: ["tenant_admin"],
    profile: "work",
    source: "env",
    storeKind: "keyring",
    setActive: false,
  };

  test("env-scoped, not active: source tag + prettified role + env note", () => {
    const out = formatLoginSummary(base);
    expect(out).toContain("✓ authenticated as david@goflowstate.com");
    expect(out).toContain("organization: acme");
    expect(out).toContain("role:         Tenant Admin");
    expect(out).toContain("profile:      work  (from $REOCLO_PROFILE)");
    expect(out).toContain("credentials:  keyring");
    expect(out).toContain("$REOCLO_PROFILE is set");
    expect(out).toContain("reoclo profile use work");
  });
  test("flag-scoped, not active: --profile tag + flag-specific note", () => {
    const out = formatLoginSummary({ ...base, source: "flag" });
    expect(out).toContain("profile:      work  (from --profile)");
    expect(out).toContain("--profile for this login only");
  });
  test("bare login, active: no source tag, no note", () => {
    const out = formatLoginSummary({
      ...base,
      profile: "default",
      source: "default",
      setActive: true,
    });
    expect(out).toContain("profile:      default");
    expect(out).not.toContain("(from");
    expect(out).not.toContain("note:");
  });
  test("omits the role line when roles is empty", () => {
    const out = formatLoginSummary({ ...base, roles: [], setActive: true });
    expect(out).not.toContain("role:");
  });
  test("joins multiple roles, prettified", () => {
    const out = formatLoginSummary({
      ...base,
      roles: ["tenant_admin", "viewer"],
      setActive: true,
    });
    expect(out).toContain("role:         Tenant Admin, Viewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/commands/login-summary.test.ts`
Expected: FAIL — cannot resolve module `../../../src/commands/login-summary`.

- [ ] **Step 3: Write minimal implementation**

Create `src/commands/login-summary.ts`:

```ts
// src/commands/login-summary.ts
//
// Pure, network-free helpers for `reoclo login`'s post-auth behavior:
//  - shouldSetActiveProfile: whether to point the GLOBAL active profile at the
//    profile we just authenticated (Option A — scoped logins don't mutate it).
//  - formatLoginSummary: the multi-line success block printed after login.
// Kept out of login.ts so they unit-test without the OAuth device flow, the
// keyring, or the network.
import type { ProfileSource } from "../config/profile-resolve";
import { formatRole } from "../ui/format-role";

/**
 * Option A: `login` sets the just-authenticated profile as the GLOBAL active
 * profile only when (a) it is the first profile on the machine, or (b) the
 * login was not scoped by --profile/$REOCLO_PROFILE (a bare `reoclo login`,
 * which always targets "default"). A scoped login with profiles already
 * present leaves the global active profile untouched.
 */
export function shouldSetActiveProfile(opts: {
  hadNoProfiles: boolean;
  source: ProfileSource;
}): boolean {
  return opts.hadNoProfiles || opts.source === "default";
}

export interface LoginSummaryInput {
  email: string;
  org: string; // me.tenant_slug
  roles: string[]; // me.roles
  profile: string; // resolved profile name
  source: ProfileSource;
  storeKind: "keyring" | "file" | "memory";
  setActive: boolean; // result of shouldSetActiveProfile()
}

/** Compose the multi-line `reoclo login` success block. */
export function formatLoginSummary(i: LoginSummaryInput): string {
  const lines: string[] = [];
  lines.push(`✓ authenticated as ${i.email}`);
  lines.push(`  organization: ${i.org}`);
  if (i.roles.length > 0) {
    lines.push(`  role:         ${i.roles.map(formatRole).join(", ")}`);
  }
  const sourceTag =
    i.source === "env"
      ? "  (from $REOCLO_PROFILE)"
      : i.source === "flag"
        ? "  (from --profile)"
        : "";
  lines.push(`  profile:      ${i.profile}${sourceTag}`);
  lines.push(`  credentials:  ${i.storeKind}`);
  if (!i.setActive) {
    const why =
      i.source === "env"
        ? "it's used automatically while $REOCLO_PROFILE is set"
        : "it was selected with --profile for this login only";
    lines.push(`  note: '${i.profile}' isn't your active profile — ${why};`);
    lines.push(`        run 'reoclo profile use ${i.profile}' to make it the default.`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/commands/login-summary.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/login-summary.ts tests/unit/commands/login-summary.test.ts
git commit -m "feat(cli): add login active-profile decision + feedback summary helpers"
```

---

### Task 5: Wire source + active-profile + summary into `login`

**Files:**
- Modify: `src/commands/login.ts`
- Test: `tests/unit/commands/login.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/commands/login.test.ts`, extend the existing tests to assert the resolved `source`, and add an env-based test. Replace the three existing tests inside `describe("login honors the global --profile flag", ...)` with:

```ts
  test("`login --profile staging` targets staging with source 'flag'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    await withoutEnvProfile(() =>
      buildProgram(captured).parseAsync(["node", "reoclo", "login", "--profile", "staging"]),
    );
    expect(captured.opts?.profile).toBe("staging");
    expect(captured.opts?.source).toBe("flag");
  });

  test("`login --profile=prod` targets prod with source 'flag'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    await withoutEnvProfile(() =>
      buildProgram(captured).parseAsync(["node", "reoclo", "login", "--profile=prod"]),
    );
    expect(captured.opts?.profile).toBe("prod");
    expect(captured.opts?.source).toBe("flag");
  });

  test("bare `login` defaults to 'default' with source 'default'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    await withoutEnvProfile(() =>
      buildProgram(captured).parseAsync(["node", "reoclo", "login"]),
    );
    expect(captured.opts?.profile).toBe("default");
    expect(captured.opts?.source).toBe("default");
  });

  test("`login` honors $REOCLO_PROFILE with source 'env'", async () => {
    const captured: { opts?: LoginFlowOptions } = {};
    const saved = process.env.REOCLO_PROFILE;
    process.env.REOCLO_PROFILE = "work";
    try {
      await buildProgram(captured).parseAsync(["node", "reoclo", "login"]);
    } finally {
      if (saved === undefined) delete process.env.REOCLO_PROFILE;
      else process.env.REOCLO_PROFILE = saved;
    }
    expect(captured.opts?.profile).toBe("work");
    expect(captured.opts?.source).toBe("env");
  });
```

(Leave the final test — "login declares no command-local --profile option" — unchanged.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/commands/login.test.ts`
Expected: FAIL — `captured.opts?.source` is `undefined` (the action does not yet compute/pass `source`); also a TypeScript error that `source` is missing on `LoginFlowOptions`.

- [ ] **Step 3: Write minimal implementation**

Edit `src/commands/login.ts`:

**(a)** Update imports. Change the profile-resolve import line:

```ts
import { resolveCommandProfile } from "../config/profile-resolve";
```

to:

```ts
import { resolveCommandProfileWithSource, type ProfileSource } from "../config/profile-resolve";
```

Add the store import for `setActiveProfile` (extend the existing store import):

```ts
import { loadConfig, saveProfile, setActiveProfile, type ProfileRecord } from "../config/store";
```

Add a new import for the summary helpers:

```ts
import { shouldSetActiveProfile, formatLoginSummary } from "./login-summary";
```

**(b)** Add `source` to `LoginFlowOptions`:

```ts
export interface LoginFlowOptions {
  profile: string;
  source: ProfileSource;
  api: string;
  auth: string;
  streams?: string;
  keyring?: boolean;
  browser?: boolean;
}
```

**(c)** In `runDeviceFlow`, capture the pre-login profile count. Immediately before the line `// 5. Save profile` (just before `const baseProfile = await buildProfileWithCapabilities(...)`), add:

```ts
  // Capture whether this is the first profile on the machine BEFORE we write
  // anything — drives the Option-A active-profile decision below.
  const hadNoProfiles = Object.keys((await loadConfig()).profiles).length === 0;
```

**(d)** Replace the success block. Change the final lines of `runDeviceFlow`:

```ts
  // Identity (re)established — drop any stale completion cache for this tenant
  // so the next completion re-warms fresh data for the account just signed in.
  clearTenant(me.tenant_id);

  // 6. Success
  console.log(`✓ saved to ${store.kind} — authenticated as ${me.email} (organization: ${me.tenant_slug})`);
```

to:

```ts
  // Option A: set the GLOBAL active profile only on a first/bare login; a
  // scoped login (--profile / $REOCLO_PROFILE) must not change it.
  const setActive = shouldSetActiveProfile({ hadNoProfiles, source: opts.source });
  if (setActive) await setActiveProfile(profileName);

  // Identity (re)established — drop any stale completion cache for this tenant
  // so the next completion re-warms fresh data for the account just signed in.
  clearTenant(me.tenant_id);

  // 6. Success
  console.log(
    formatLoginSummary({
      email: me.email,
      org: me.tenant_slug,
      roles: me.roles ?? [],
      profile: profileName,
      source: opts.source,
      storeKind: store.kind,
      setActive,
    }),
  );
```

**(e)** In `registerLogin`'s action, compute and pass `source`. Replace:

```ts
        await runFlow({
          // Resolve from the global --profile flag (then $REOCLO_PROFILE), with a
          // fresh login defaulting to the "default" profile when neither is set.
          profile: resolveCommandProfile(command, "default"),
          api: opts.api,
          auth: opts.auth ?? deriveAuthFromApi(opts.api) ?? authUrl(),
          streams: opts.streams,
          keyring: opts.keyring,
          browser: opts.browser,
        });
```

with:

```ts
        // Resolve from the global --profile flag (then $REOCLO_PROFILE), with a
        // fresh login defaulting to the "default" profile when neither is set.
        // `source` records which of those produced the name so login can decide
        // whether to touch the global active profile and annotate its feedback.
        const { name: profile, source } = resolveCommandProfileWithSource(command, "default");
        await runFlow({
          profile,
          source,
          api: opts.api,
          auth: opts.auth ?? deriveAuthFromApi(opts.api) ?? authUrl(),
          streams: opts.streams,
          keyring: opts.keyring,
          browser: opts.browser,
        });
```

- [ ] **Step 4: Run test + typecheck to verify**

Run: `bun test tests/unit/commands/login.test.ts && bun run typecheck`
Expected: PASS — all four parametrized tests assert the correct `source`; typecheck clean (`LoginFlowOptions.source` is satisfied by the action and `me.roles` exists on `Me`).

- [ ] **Step 5: Commit**

```bash
git add src/commands/login.ts tests/unit/commands/login.test.ts
git commit -m "feat(cli): login sets active profile per Option A + richer feedback (profile/source/role)"
```

---

### Task 6: Prettify role in `whoami`

**Files:**
- Modify: `src/commands/whoami.ts`

- [ ] **Step 1: Apply the change**

In `src/commands/whoami.ts`, add the import near the top:

```ts
import { formatRole } from "../ui/format-role";
```

Then change the membership line (currently `console.log(\`  ${slug}  ${m.tenant_name}  (${m.role})\`);`) to:

```ts
          console.log(`  ${slug}  ${m.tenant_name}  (${formatRole(m.role)})`);
```

- [ ] **Step 2: Verify typecheck + suite (no isolated test; transformation covered by Task 1)**

Run: `bun run typecheck && bun test`
Expected: PASS — `whoami` has no dedicated unit test (it bootstraps + hits the network); the role transform itself is covered by `format-role.test.ts`, and the full suite confirms no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/commands/whoami.ts
git commit -m "feat(cli): prettify membership role in whoami"
```

---

### Task 7: Prettify role in `org ls` (text mode only; raw for json/yaml)

**Files:**
- Modify: `src/commands/org.ts`
- Test: `tests/unit/commands/org-rows.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/commands/org-rows.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildOrgRows } from "../../../src/commands/org";
import type { OrgMembership } from "../../../src/client/types";

const memberships: OrgMembership[] = [
  { id: "1", tenant_id: "t1", tenant_slug: "acme", tenant_name: "Acme", role: "tenant_admin" },
  { id: "2", tenant_id: "t2", tenant_slug: "beta", tenant_name: "Beta", role: "viewer" },
];

describe("buildOrgRows", () => {
  test("text mode prettifies the role and marks the active org", () => {
    const rows = buildOrgRows(memberships, "t1", "text");
    expect(rows[0]).toEqual({ active: "*", slug: "acme", name: "Acme", role: "Tenant Admin" });
    expect(rows[1]).toEqual({ active: "", slug: "beta", name: "Beta", role: "Viewer" });
  });
  test("json mode keeps the raw role for machine consumers", () => {
    const rows = buildOrgRows(memberships, "t1", "json");
    expect(rows[0].role).toBe("tenant_admin");
    expect(rows[1].role).toBe("viewer");
  });
  test("yaml mode keeps the raw role and marks the active org", () => {
    const rows = buildOrgRows(memberships, "t2", "yaml");
    expect(rows[0].role).toBe("tenant_admin");
    expect(rows[1].active).toBe("*");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/commands/org-rows.test.ts`
Expected: FAIL — `buildOrgRows` is not exported from `../../../src/commands/org`.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/org.ts`:

**(a)** Add imports near the top (after the existing `Me` import):

```ts
import type { Me, OrgMembership } from "../client/types";
import { formatRole } from "../ui/format-role";
import type { OutputFormat } from "../ui/output";
```

(The file already imports `Me` from `../client/types`; merge `OrgMembership` into that import as shown and drop the old `Me`-only import line.)

**(b)** Add the exported pure helper above `registerOrg`:

```ts
/**
 * Build the rows for `org ls`. The role is humanized for human/text output but
 * kept RAW for machine output (`-o json` / `-o yaml`) so scripts still match on
 * the server value (e.g. "tenant_admin").
 */
export function buildOrgRows(
  memberships: OrgMembership[],
  activeTenantId: string,
  fmt: OutputFormat,
): Array<{ active: string; slug: string; name: string; role: string }> {
  return memberships.map((m) => ({
    active: m.tenant_id === activeTenantId ? "*" : "",
    slug: m.tenant_slug,
    name: m.tenant_name,
    role: fmt === "text" ? formatRole(m.role) : m.role,
  }));
}
```

**(c)** In the `g.command("ls")` action, replace the inline `const rows = memberships.map(...)`:

```ts
      const memberships = me.memberships ?? [];
      const rows = memberships.map((m) => ({
        active: m.tenant_id === me.tenant_id ? "*" : "",
        slug: m.tenant_slug,
        name: m.tenant_name,
        role: m.role,
      }));
```

with:

```ts
      const memberships = me.memberships ?? [];
      const rows = buildOrgRows(memberships, me.tenant_id, fmt);
```

(`fmt` is already defined earlier in the action via `const fmt = resolveFormat(globalOutput(program));`.)

- [ ] **Step 4: Run test + typecheck to verify**

Run: `bun test tests/unit/commands/org-rows.test.ts && bun run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/org.ts tests/unit/commands/org-rows.test.ts
git commit -m "feat(cli): prettify org ls role in text mode (raw for json/yaml)"
```

---

### Task 8: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — entire suite green (new tests + no regressions; pay attention to `config/`, `commands/`, and `completion/` suites that read `config.json`).

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: No type errors; no new lint errors. (If lint flags `no-base-to-string` or unused imports, fix inline and amend the relevant task's commit.)

- [ ] **Step 3: Manual smoke (optional, requires a real/dev auth endpoint)**

If a dev environment is reachable, exercise the three paths and confirm feedback wording + that global active doesn't move on a scoped login:

```bash
# scoped login leaves global active unchanged (run against a non-default profile)
REOCLO_PROFILE=work bun run src/index.ts login
bun run src/index.ts profile current   # should still resolve via env to 'work'
bun run src/index.ts profile ls        # 'work' present; active marker (*) unchanged unless first profile
bun run src/index.ts org ls            # role column humanized
bun run src/index.ts org ls -o json    # role raw (tenant_admin)
```

- [ ] **Step 4: Push the branch**

```bash
git push -u origin fix/cli-login-profile-active
```

(Open the PR against reoclo-cli `main` only when the user asks; see "Shipping" note below.)

---

## Self-Review

**1. Spec coverage:**
- Change 1 (no implicit flip + Option A) → Task 2 (saveProfile pure), Task 4 (`shouldSetActiveProfile`), Task 5 (wire `setActiveProfile` + `hadNoProfiles`). ✓
- Change 1b (source-aware resolution, blank/unset env → default) → Task 3. ✓
- Change 2 (feedback: profile + source + role + note) → Task 4 (`formatLoginSummary`), Task 5 (wiring). ✓
- Change 3 (prettified role) → Task 1 (`formatRole`), Task 5 (login), Task 6 (whoami), Task 7 (org ls text-only). ✓
- Spec "Files touched" table → all six source files + tests covered. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**3. Type consistency:** `ProfileSource` defined in Task 3, imported by Tasks 4 & 5. `LoginSummaryInput`/`formatLoginSummary`/`shouldSetActiveProfile` names identical across Tasks 4–5. `LoginFlowOptions.source` added in Task 5 matches the `source` asserted in `login.test.ts`. `buildOrgRows` signature `(OrgMembership[], string, OutputFormat)` identical in Task 7 impl + test. `me.roles` (string[]) exists on `Me` (`src/client/types.ts:19`). `store.kind` ∈ {keyring,file,memory} matches `LoginSummaryInput.storeKind`. ✓

---

## Shipping note (post-merge)

This is a behavior change to `login` + new feedback, so it warrants a CLI version bump and release per the **reoclo-cli-shipping-internal** skill. After the implementation merges to reoclo-cli `main`, the parent `suva` repo's `cli` submodule pointer must be bumped to the new commit (on its own branch/PR) — and the spec can be mirrored into the parent `docs/superpowers/specs/` registry at that time if desired. Do the version bump/release only when the user asks.
