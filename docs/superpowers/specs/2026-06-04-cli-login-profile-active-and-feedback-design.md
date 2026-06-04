# CLI Login — Profile-Scoped Active Handling, Feedback & Prettified Roles

**Date:** 2026-06-04
**Status:** Approved (design) — pending implementation plan
**Scope:** `cli/` only. No `api/`, `auth/`, or `web/` change.

## Problem

`reoclo login` has a surprising, sticky side effect on which profile is
*globally* active, and its success feedback hides two useful facts (which
profile you actually logged into, and your role).

### 1. Implicit active-profile flip (the bug)

`saveProfile()` mutates `active_profile` as a side effect of **any** profile
write whenever the current active is empty or `"default"`:

```ts
// cli/src/config/store.ts:71-76
export async function saveProfile(name: string, profile: ProfileRecord): Promise<void> {
  const cfg = await loadConfig();
  cfg.profiles[name] = profile;
  if (!cfg.active_profile || cfg.active_profile === "default") cfg.active_profile = name; // ← the problem
  await writeConfig(cfg);
}
```

`saveProfile` is called from four sites: `login` (3×), token persistence
(`FileStore.set` → `saveProfile`, `cli/src/config/keyring/file.ts:14`), token
refresh (`bootstrap onExpiry` → `saveProfile`, `cli/src/client/bootstrap.ts:177`),
and `org use` (`cli/src/commands/org.ts:138`, where `name === active_profile`,
so a no-op).

Consequences of the implicit flip:

- **Cross-shell leak.** `REOCLO_PROFILE=work reoclo login` is meant to be
  shell-scoped, but if the persisted `active_profile` is still `"default"` it
  silently rewrites the *global* `active_profile` to `work` in `config.json`,
  changing the default profile for **other** shells that have no
  `REOCLO_PROFILE` set. The inverse is also surprising: if active is already a
  non-default name, the flip does **not** fire, so a scoped login does not
  switch and a fresh shell stays on the old profile.
- **Latent refresh bug.** Because `bootstrap onExpiry` and `FileStore.set` also
  go through `saveProfile`, a routine **token refresh on a scoped command**
  (`--profile work` / `$REOCLO_PROFILE=work` while global active is `default`)
  silently flips global active to `work` — with no login at all.

### 2. Feedback omits the profile + its source

Login prints one line (`cli/src/commands/login.ts:174`):

```
✓ saved to keyring — authenticated as david@goflowstate.com (organization: acme)
```

It never says **which profile** was written, nor that the profile name came
from `$REOCLO_PROFILE` rather than an explicit choice. A user relying on the env
var has no confirmation they hit the intended profile.

### 3. Roles are shown raw

Roles are snake_case server strings — `tenant_admin`, `developer`, `deployer`,
`viewer`, `super_admin` (`api/seed.py:58-106`). Login feedback shows no role at
all, and `whoami` / `org ls` print the raw `tenant_admin`. The web already has a
`formatRole()` humanizer (`auth/src/lib/oauth-client.ts:41`); the CLI has none.

## Goals

1. Make `reoclo login`'s effect on the **global active profile** predictable and
   never leak across shells (Option A, below).
2. Surface the resolved profile and its source in login feedback.
3. Show a human-readable (prettified) role wherever roles are shown to a person,
   without corrupting machine (`-o json`/`yaml`) output.

## Non-goals

- No change to token storage layout, keyring keys, or the OAuth device flow.
- No change to `api/`, `auth/`, or `web/`.
- No new `profile add`/import command (login remains the only profile creator).

---

## Design

### Change 1 — Explicit, scoped-aware active-profile handling

**1a. `saveProfile` becomes a pure profile write.** Drop the `active_profile`
mutation entirely:

```ts
export async function saveProfile(name: string, profile: ProfileRecord): Promise<void> {
  const cfg = await loadConfig();
  cfg.profiles[name] = profile;
  await writeConfig(cfg);
}
```

This removes the side effect from all four call sites at once — fixing both the
cross-shell leak and the latent refresh-flips-active bug. `login` is the only
command that creates a profile from scratch, so it becomes the only place that
must set active explicitly.

**1b. Source-aware profile resolution.** Add to `cli/src/config/profile-resolve.ts`:

```ts
export type ProfileSource = "flag" | "env" | "default";

/** Resolve the target profile AND where the name came from, using the same
 *  precedence as resolveCommandProfile: --profile flag → $REOCLO_PROFILE →
 *  fallback. Empty/whitespace env (and absent flag) fall through to the
 *  fallback with source "default". */
export function resolveCommandProfileWithSource(
  command: GlobalOptsCommand,
  fallback: string,
): { name: string; source: ProfileSource } {
  const flag = globalProfileFlag(command);        // already non-empty or undefined
  if (flag) return { name: flag, source: "flag" };
  const env = pick(process.env.REOCLO_PROFILE);    // trims; blank/unset → undefined
  if (env) return { name: env, source: "env" };
  return { name: fallback, source: "default" };
}
```

`resolveCommandProfile(command, fallback)` is reduced to a thin wrapper returning
`.name`, so every existing caller is unchanged. Per the confirmed requirement,
**`REOCLO_PROFILE` unset or blank → `default`** (existing `pick()` semantics).

**1c. Login's active-profile rule (Option A).** Capture the pre-login profile
count, then after the profile is written decide via a pure helper:

```ts
/** Whether `reoclo login` should set the just-authenticated profile as the
 *  global active profile. Option A: scoped logins (env/flag) never mutate the
 *  global active unless this is the first profile on the machine. */
export function shouldSetActiveProfile(opts: {
  hadNoProfiles: boolean;       // config had zero profiles BEFORE this login
  source: ProfileSource;
}): boolean {
  return opts.hadNoProfiles || opts.source === "default";
}
```

Behaviour matrix:

| Scenario | `source` | profiles existed? | sets active? |
|---|---|---|---|
| First login on the machine (any) | any | no | **yes** (tool must be usable) |
| Bare `reoclo login` | `default` | yes | **yes** → `default` |
| `--profile work` / `REOCLO_PROFILE=work` | `flag`/`env` | yes | **no** (leave global active) |

`login` sets active via the existing `setActiveProfile(profileName)`
(`store.ts:95`), which is safe because the profile row already exists by then.
`hadNoProfiles` is read from `loadConfig()` **once at the start** of the flow,
before any `saveProfile`/`store.set` call.

`LoginFlowOptions` gains a `source: ProfileSource` field so the injected flow
runner is fully testable; the `login` action computes it via
`resolveCommandProfileWithSource(command, "default")`.

### Change 2 — Feedback shows profile + source + role

Replace the single `console.log` at `login.ts:174` with output composed by a
pure, network-free helper so it can be unit-tested:

```ts
export interface LoginSummaryInput {
  email: string;
  org: string;          // me.tenant_slug
  roles: string[];      // me.roles
  profile: string;      // resolved profile name
  source: ProfileSource;
  storeKind: "keyring" | "file" | "memory";
  setActive: boolean;   // result of shouldSetActiveProfile()
}
export function formatLoginSummary(i: LoginSummaryInput): string { /* … */ }
```

Rendered example — `REOCLO_PROFILE=work`, role `tenant_admin`, active left
unchanged:

```
✓ authenticated as david@goflowstate.com
  organization: acme
  role:         Tenant Admin
  profile:      work  (from $REOCLO_PROFILE)
  credentials:  keyring
  note: 'work' isn't your active profile — it's used while $REOCLO_PROFILE is set;
        run 'reoclo profile use work' to make it the default.
```

Rules:

- Always show `profile:`; append `(from $REOCLO_PROFILE)` when `source==="env"`,
  `(from --profile)` when `source==="flag"`, nothing when `source==="default"`.
- `role:` shows `i.roles.map(formatRole).join(", ")`; the line is **omitted**
  when `roles` is empty.
- The `note:` block is shown **only when `setActive === false`** (scoped login
  that left global active untouched).
- Bare and first-ever logins drop both the source tag and the note.

### Change 3 — Prettified roles

New shared helper `cli/src/ui/format-role.ts`, mirroring the web humanizer:

```ts
/** Humanize a role string for display, e.g. "tenant_admin" → "Tenant Admin". */
export function formatRole(role: string): string {
  return role.replace(/[_-]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}
```

Applied at every **human-facing** role display:

- **Login feedback** — via `formatLoginSummary` (Change 2).
- **`whoami`** (`cli/src/commands/whoami.ts:30`) — `(${formatRole(m.role)})`.
- **`org ls`** (`cli/src/commands/org.ts:38-43`) — prettify **only in text/table
  mode**, keep the raw role for machine output:

  ```ts
  role: fmt === "text" ? formatRole(m.role) : m.role,
  ```

  `fmt` comes from the existing `resolveFormat(globalOutput(program))`
  (`text` | `json` | `yaml`), so `-o json` / `-o yaml` consumers still receive
  the raw `tenant_admin` value.

---

## Files touched

| File | Change |
|---|---|
| `cli/src/config/store.ts` | `saveProfile` no longer mutates `active_profile` |
| `cli/src/config/profile-resolve.ts` | add `ProfileSource`, `resolveCommandProfileWithSource`; `resolveCommandProfile` → wrapper |
| `cli/src/commands/login.ts` | source-aware resolve, `shouldSetActiveProfile`, explicit `setActiveProfile`, `formatLoginSummary` output; `LoginFlowOptions.source` |
| `cli/src/ui/format-role.ts` | **new** `formatRole` helper |
| `cli/src/commands/whoami.ts` | prettify membership role |
| `cli/src/commands/org.ts` | prettify role in text mode only |

Pure helpers extracted for testability: `resolveCommandProfileWithSource`,
`shouldSetActiveProfile`, `formatLoginSummary`, `formatRole`.

## Testing

Unit (bun:test, no network/keyring):

- `resolveCommandProfileWithSource`: `--profile` → `flag`; `$REOCLO_PROFILE=x` →
  `env`; blank/whitespace `$REOCLO_PROFILE` → `default`; unset → `default`; flag
  beats env.
- `shouldSetActiveProfile`: first-profile (any source) → true; `default` → true;
  `flag`/`env` with existing profiles → false.
- `formatRole`: `tenant_admin`→`Tenant Admin`, `super_admin`→`Super Admin`,
  `viewer`→`Viewer`, already-spaced / mixed-case inputs.
- `formatLoginSummary`: env tag + note present when scoped/not-active; no
  tag/note for bare login; role line omitted when `roles` empty; multiple roles
  joined.
- `saveProfile`: a write to a non-active profile while active is `default`
  leaves `active_profile` unchanged (regression test for the removed flip);
  update existing `cli/tests/unit/config/store.test.ts` expectations accordingly.

Existing `cli/tests/unit/commands/login.test.ts` already injects the flow
runner; extend it to assert the resolved `source` and the active-profile
decision per scenario.

## Risks / migration

- **Behavior change for existing scripts.** Anyone who *relied* on a scoped
  login flipping global active no longer gets that; they run
  `reoclo profile use <name>` (the note tells them). This is the intended fix.
- **No data migration** — `config.json` shape is unchanged. Existing
  `active_profile` values are respected as-is.
- Touching `store.test.ts` is required since it asserts the old flip behavior.
