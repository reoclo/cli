import { expect, test, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { seedTenantProfile } from "../helpers/seed-profile";

let tmp: string;
let gw: FakeGateway;

beforeEach(() => {
  gw = startFakeGateway();
  tmp = mkdtempSync(join(tmpdir(), "reoclo-dnsrec-"));
  process.env.REOCLO_CACHE_DIR = join(tmp, "cache");
  seedTenantProfile({ configDir: tmp, apiUrl: gw.url, token: gw.token });
});

afterEach(() => {
  gw.stop();
});

function env(): Record<string, string | undefined> {
  return { ...process.env, REOCLO_CONFIG_DIR: tmp, REOCLO_CACHE_DIR: join(tmp, "cache") };
}

test("dns records ls prints the records and flags the ones Reoclo manages", async () => {
  const r = await $`bun run src/index.ts dns records ls example.com`.env(env()).quiet();
  const out = r.stdout.toString();
  expect(out).toContain("_dmarc.example.com");
  expect(out).toContain("mail.example.com");
  expect(out).toContain("reoclo");
  expect(gw.dnsRecordRequests).toEqual([{ method: "GET", search: "?name=example.com", body: null }]);
});

test("dns records ls --type filters on the server", async () => {
  const r = await $`bun run src/index.ts dns records ls example.com --type mx`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("mail.example.com");
  expect(r.stdout.toString()).not.toContain("_dmarc");
  expect(gw.dnsRecordRequests[0]?.search).toBe("?name=example.com&type=MX");
});

test("dns records ls rejects an unsupported --type before any request", async () => {
  const r = await $`bun run src/index.ts dns records ls example.com --type A`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(2);
  expect(gw.dnsRecordRequests).toEqual([]);
});

test("dns records add posts the DMARC record", async () => {
  const content = "v=DMARC1; p=none; rua=mailto:dmarc@example.com";
  const r = await $`bun run src/index.ts dns records add _dmarc.example.com --type TXT --content ${content}`
    .env(env())
    .quiet();
  expect(r.stdout.toString()).toContain("✓ added TXT _dmarc.example.com");
  expect(gw.dnsRecordRequests).toEqual([
    { method: "POST", search: "", body: { type: "TXT", name: "_dmarc.example.com", content } },
  ]);
});

test("dns records add MX sends the priority and ttl", async () => {
  await $`bun run src/index.ts dns records add example.com --type MX --content mail.example.com --priority 10 --ttl 300`
    .env(env())
    .quiet();
  expect(gw.dnsRecordRequests[0]?.body).toEqual({
    type: "MX",
    name: "example.com",
    content: "mail.example.com",
    priority: 10,
    ttl: 300,
  });
});

test("dns records add MX without a priority exits 2 and sends nothing", async () => {
  const r = await $`bun run src/index.ts dns records add example.com --type MX --content mail.example.com`
    .env(env())
    .nothrow()
    .quiet();
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("--priority");
  expect(gw.dnsRecordRequests).toEqual([]);
});

test("dns records rm --yes deletes with the zone in the query", async () => {
  const r = await $`bun run src/index.ts dns records rm a1 --zone example.com --yes`.env(env()).quiet();
  expect(r.stdout.toString()).toContain("✓ record removed: a1 from example.com");
  expect(gw.dnsRecordRequests).toEqual([{ method: "DELETE", search: "?zone=example.com", body: null }]);
});

test("dns records rm without --yes and without a TTY aborts and deletes nothing", async () => {
  const r = await $`bun run src/index.ts dns records rm a1 --zone example.com`.env(env()).nothrow().quiet();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("aborted (pass --yes to confirm non-interactively)");
  expect(gw.dnsRecordRequests).toEqual([]);
});

test("dns records rm requires --zone", async () => {
  const r = await $`bun run src/index.ts dns records rm a1 --yes`.env(env()).nothrow().quiet();
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("--zone");
  expect(gw.dnsRecordRequests).toEqual([]);
});
