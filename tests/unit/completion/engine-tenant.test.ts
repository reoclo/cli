// tests/unit/completion/engine-tenant.test.ts
//
// The completion engine (the zero-network __complete process) must scope its
// candidates to the authorised tenant: the active profile's tenant by default,
// or the tenant of a `--profile <name>` typed on the completion line.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getCompletionCandidates } from "../../../src/completion/engine";
import { withCompletion } from "../../../src/client/command-meta";
import { setActiveTenantId, writeSlice } from "../../../src/completion/cache";

let cacheTmp: string;
let cfgTmp: string;
beforeEach(() => {
  cacheTmp = mkdtempSync(join(tmpdir(), "reoclo-eng-cache-"));
  cfgTmp = mkdtempSync(join(tmpdir(), "reoclo-eng-cfg-"));
  process.env.REOCLO_CACHE_DIR = cacheTmp;
  process.env.REOCLO_CONFIG_DIR = cfgTmp;
  delete process.env.REOCLO_PROFILE;
  writeFileSync(
    join(cfgTmp, "config.json"),
    JSON.stringify({
      active_profile: "default",
      profiles: { default: { tenant_id: "T1" }, staging: { tenant_id: "T2" } },
    }),
    "utf8",
  );
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_PROFILE;
  setActiveTenantId(undefined);
  rmSync(cacheTmp, { recursive: true, force: true });
  rmSync(cfgTmp, { recursive: true, force: true });
});

function program(): Command {
  const p = new Command().name("reoclo");
  // Mirror index.ts: --profile is a global, value-taking root option so walk()
  // skips it and its value.
  p.option("--profile <name>", "use a named profile");
  const servers = p.command("servers");
  withCompletion(servers.command("get <id>"), { args: [{ slot: 0, resource: "servers" }] });
  return p;
}

function seedTwoTenants(): void {
  setActiveTenantId("T1");
  writeSlice("servers", [{ id: "1", value: "t1-web", name: "", desc: "" }]);
  setActiveTenantId("T2");
  writeSlice("servers", [{ id: "2", value: "t2-web", name: "", desc: "" }]);
  setActiveTenantId(undefined); // simulate a fresh __complete process
}

describe("completion is scoped to the authorised tenant", () => {
  test("uses the active profile's tenant by default", () => {
    seedTwoTenants();
    const cands = getCompletionCandidates(program(), ["servers", "get"], "");
    expect(cands.map((c) => c.value)).toEqual(["t1-web"]);
  });

  test("honors --profile typed on the completion line", () => {
    seedTwoTenants();
    const cands = getCompletionCandidates(
      program(),
      ["--profile", "staging", "servers", "get"],
      "",
    );
    expect(cands.map((c) => c.value)).toEqual(["t2-web"]);
  });
});
