// tests/unit/completion/engine-tenant.test.ts
//
// The completion engine (the zero-network __complete process) must scope its
// candidates to the org the completed command will target: `--org` typed on
// the line, else $REOCLO_ORG, else the `.reoclo` binding of the working
// directory. With none of those there is NO org, and no candidates: the
// profile's login org is never a source.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { getCompletionCandidates } from "../../../src/completion/engine";
import { withCompletion } from "../../../src/client/command-meta";
import { setActiveOrg, writeSlice } from "../../../src/completion/cache";

let cacheTmp: string;
let cfgTmp: string;
let projTmp: string;
beforeEach(() => {
  cacheTmp = mkdtempSync(join(tmpdir(), "reoclo-eng-cache-"));
  cfgTmp = mkdtempSync(join(tmpdir(), "reoclo-eng-cfg-"));
  projTmp = mkdtempSync(join(tmpdir(), "reoclo-eng-proj-"));
  process.env.REOCLO_CACHE_DIR = cacheTmp;
  process.env.REOCLO_CONFIG_DIR = cfgTmp;
  // Discovery reads $REOCLO_PROJECT_DIR (not cwd); an empty temp dir = unbound.
  process.env.REOCLO_PROJECT_DIR = projTmp;
  delete process.env.REOCLO_PROFILE;
  delete process.env.REOCLO_ORG;
  writeFileSync(
    join(cfgTmp, "config.json"),
    JSON.stringify({
      active_profile: "default",
      profiles: {
        default: { tenant_id: "T1", tenant_slug: "acme", auth_kind: "oauth" },
        staging: { tenant_id: "T2", tenant_slug: "acme", auth_kind: "oauth" },
      },
    }),
    "utf8",
  );
});
afterEach(() => {
  delete process.env.REOCLO_CACHE_DIR;
  delete process.env.REOCLO_CONFIG_DIR;
  delete process.env.REOCLO_PROJECT_DIR;
  delete process.env.REOCLO_PROFILE;
  delete process.env.REOCLO_ORG;
  setActiveOrg(undefined, undefined);
  for (const d of [cacheTmp, cfgTmp, projTmp]) rmSync(d, { recursive: true, force: true });
});

function program(): Command {
  const p = new Command().name("reoclo");
  // Mirror index.ts: --profile / --org are global, value-taking root options so
  // walk() skips them and their values.
  p.option("--profile <name>", "use a named profile");
  p.option("--org <slug>", "run against this organization");
  const servers = p.command("servers");
  withCompletion(servers.command("get <id>"), { args: [{ slot: 0, resource: "servers" }] });
  return p;
}

function seed(): void {
  setActiveOrg("default", "acme");
  writeSlice("servers", [{ id: "1", value: "acme-web", name: "", desc: "" }]);
  setActiveOrg("default", "beta");
  writeSlice("servers", [{ id: "2", value: "beta-web", name: "", desc: "" }]);
  setActiveOrg("staging", "acme");
  writeSlice("servers", [{ id: "3", value: "stg-acme-web", name: "", desc: "" }]);
  setActiveOrg(undefined, undefined); // simulate a fresh __complete process
}

const values = (words: string[]) =>
  getCompletionCandidates(program(), words, "").map((c) => c.value);

describe("completion is scoped to the org the command will target", () => {
  test("unbound (no --org, no $REOCLO_ORG, no .reoclo): no candidates, never the login org", () => {
    seed();
    expect(values(["servers", "get"])).toEqual([]);
  });

  test("honors --org typed on the completion line", () => {
    seed();
    expect(values(["--org", "beta", "servers", "get"])).toEqual(["beta-web"]);
    expect(values(["servers", "get", "--org", "acme"])).toEqual(["acme-web"]);
  });

  test("honors --org=<slug>", () => {
    seed();
    expect(values(["--org=beta", "servers", "get"])).toEqual(["beta-web"]);
  });

  test("honors $REOCLO_ORG", () => {
    seed();
    process.env.REOCLO_ORG = "acme";
    expect(values(["servers", "get"])).toEqual(["acme-web"]);
  });

  test("--org on the line wins over $REOCLO_ORG", () => {
    seed();
    process.env.REOCLO_ORG = "acme";
    expect(values(["--org", "beta", "servers", "get"])).toEqual(["beta-web"]);
  });

  test("honors the .reoclo binding of the working directory", () => {
    seed();
    writeFileSync(join(projTmp, ".reoclo"), JSON.stringify({ org: "beta" }), "utf8");
    expect(values(["servers", "get"])).toEqual(["beta-web"]);
  });

  test("--profile on the line selects that profile's bucket for the same slug", () => {
    seed();
    expect(values(["--profile", "staging", "--org", "acme", "servers", "get"])).toEqual([
      "stg-acme-web",
    ]);
  });
});
