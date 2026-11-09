import { messageOf, rejectionOf } from "../../helpers/rejection";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
  LEAF_VALIDITY_DAYS,
  LeafIssuer,
  buildNameConstraints,
  createCa,
  ensureCa,
  leafNeedsRenewal,
  loadCa,
  mintLeaf,
  parseNameConstraints,
  readCaInfo,
  removeCa,
} from "../../../src/tunnels/ca";

const DAY = 86_400_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-ca-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("name constraints", () => {
  it("round-trips a short list", () => {
    const der = buildNameConstraints(["reoclo.localhost", "internal"]);
    expect(der[0]).toBe(0x30);
    expect(parseNameConstraints(der)).toEqual(["reoclo.localhost", "internal"]);
  });

  it("uses the DER long form once the content passes 127 bytes", () => {
    const suffixes = ["reoclo.localhost", ...["one", "two", "three", "four"].map((n) => `a-fairly-long-suffix-number-${n}.example.com`)];
    const der = buildNameConstraints(suffixes);
    expect(der.length).toBeGreaterThan(200);
    expect(der[1]).toBe(0x81);
    expect(parseNameConstraints(der)).toEqual(suffixes);
  });

  it("uses the two-byte long form past 255 bytes", () => {
    const suffixes = Array.from({ length: 12 }, (_, i) => `suffix-number-${i}-padding-padding.example.com`);
    const der = buildNameConstraints(suffixes);
    expect(der.length).toBeGreaterThan(256);
    expect(der[1]).toBe(0x82);
    expect(parseNameConstraints(der)).toEqual(suffixes);
  });
});

describe("the CA", () => {
  it("is a P-256 CA with a critical name constraint, a pathlen of 0 and a two-year life", async () => {
    const now = new Date("2026-11-09T10:00:00Z");
    const ca = await createCa(["internal"], { dir, now: () => now });
    const cert = new x509.X509Certificate(ca.certPem);
    expect(cert.subject).toContain("Reoclo Local CA");
    expect((cert.publicKey.algorithm as { namedCurve?: string }).namedCurve).toBe("P-256");
    const constraints = cert.extensions.find((e) => e.type === "2.5.29.30");
    expect(constraints?.critical).toBe(true);
    expect(parseNameConstraints(new Uint8Array(constraints!.value))).toEqual(["internal", "reoclo.localhost"]);
    const basic = cert.getExtension(x509.BasicConstraintsExtension);
    expect(basic).toMatchObject({ ca: true, pathLength: 0, critical: true });
    const days = (cert.notAfter.getTime() - now.getTime()) / DAY;
    expect(days).toBeGreaterThan(729);
    expect(days).toBeLessThan(731);
  });

  it("keeps the key private and the certificate readable", async () => {
    await createCa([], { dir });
    expect(statSync(join(dir, "ca.key")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readCaInfo({ dir })?.suffixes).toEqual(["reoclo.localhost"]);
  });

  it("loads again with a working signing key", async () => {
    await createCa([], { dir });
    const loaded = await loadCa({ dir });
    expect(loaded).toBeDefined();
    const leaf = await mintLeaf(loaded!, "x.reoclo.localhost");
    expect(leaf.certPem).toContain("BEGIN CERTIFICATE");
  });

  it("returns undefined when the files are missing", async () => {
    expect(await loadCa({ dir })).toBeUndefined();
    expect(readCaInfo({ dir })).toBeUndefined();
  });

  it("keeps the CA when the suffixes match and re-issues it when they change", async () => {
    const first = await ensureCa(["internal"], { dir });
    expect(first.change).toBe("created");
    const same = await ensureCa(["internal"], { dir });
    expect(same.change).toBe("unchanged");
    expect(same.ca.sha1).toBe(first.ca.sha1);
    const changed = await ensureCa(["internal", "corp.example.com"], { dir });
    expect(changed.change).toBe("reissued");
    expect(changed.previous?.sha1).toBe(first.ca.sha1);
    expect(changed.ca.sha1).not.toBe(first.ca.sha1);
    expect(changed.ca.suffixes).toEqual(["corp.example.com", "internal", "reoclo.localhost"]);
  });

  it("deletes the CA and its key", async () => {
    await createCa([], { dir });
    removeCa({ dir });
    expect(readCaInfo({ dir })).toBeUndefined();
  });
});

describe("leaf certificates", () => {
  it("carries the hostname as its only SAN, is not a CA, and chains to the CA", async () => {
    const ca = await createCa([], { dir });
    const leaf = await mintLeaf(ca, "grafana.prod-1.reoclo.localhost");
    const cert = new x509.X509Certificate(leaf.certPem);
    const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
    expect(san?.names.items.map((n) => [n.type, n.value])).toEqual([["dns", "grafana.prod-1.reoclo.localhost"]]);
    expect(cert.getExtension(x509.BasicConstraintsExtension)?.ca).toBe(false);
    expect(cert.getExtension(x509.ExtendedKeyUsageExtension)?.usages).toContain(x509.ExtendedKeyUsage.serverAuth);
    expect(await cert.verify({ publicKey: ca.cert, date: new Date() })).toBe(true);
  });

  it("is valid for 30 days", async () => {
    const ca = await createCa([], { dir });
    const now = new Date("2026-11-09T10:00:00Z");
    const leaf = await mintLeaf(ca, "x.reoclo.localhost", now);
    expect((leaf.notAfter.getTime() - now.getTime()) / DAY).toBeCloseTo(LEAF_VALIDITY_DAYS, 1);
  });

  it("will not mint a name outside the CA's constraint", async () => {
    const ca = await createCa(["internal"], { dir });
    expect(messageOf(await rejectionOf(mintLeaf(ca, "github.com")))).toMatch(/does not cover github.com/);
    expect(messageOf(await rejectionOf(mintLeaf(ca, "x.other.localhost")))).toMatch(/does not cover/);
    expect(await mintLeaf(ca, "db.internal")).toBeDefined();
  });

  it("is renewed once two thirds of its life has passed", () => {
    const leaf = { notBefore: new Date(0), notAfter: new Date(30 * DAY) };
    expect(leafNeedsRenewal(leaf, new Date(19 * DAY))).toBe(false);
    expect(leafNeedsRenewal(leaf, new Date(20 * DAY))).toBe(true);
  });
});

describe("LeafIssuer", () => {
  it("caches a leaf, renews it on the injected clock and drops the cache on reload", async () => {
    await createCa([], { dir });
    let now = new Date("2026-11-09T10:00:00Z");
    const issuer = new LeafIssuer({ dir, now: () => now });
    const first = await issuer.leaf("x.reoclo.localhost");
    expect(await issuer.leaf("x.reoclo.localhost")).toBe(first);

    now = new Date(now.getTime() + 19 * DAY);
    expect(await issuer.leaf("x.reoclo.localhost")).toBe(first);
    now = new Date(now.getTime() + 2 * DAY);
    const renewed = await issuer.leaf("x.reoclo.localhost");
    expect(renewed).not.toBe(first);
    expect(renewed.notAfter.getTime()).toBeGreaterThan(first.notAfter.getTime());

    issuer.reload();
    expect(await issuer.leaf("x.reoclo.localhost")).not.toBe(renewed);
  });

  it("mints one leaf for concurrent requests for the same name", async () => {
    await createCa([], { dir });
    const issuer = new LeafIssuer({ dir });
    const [a, b] = await Promise.all([issuer.leaf("x.reoclo.localhost"), issuer.leaf("x.reoclo.localhost")]);
    expect(a).toBe(b);
  });

  it("gives a secure context and fails clearly when there is no CA", async () => {
    const empty = new LeafIssuer({ dir });
    expect(messageOf(await rejectionOf(empty.secureContext("x.reoclo.localhost")))).toMatch(/no local CA/);
    await createCa([], { dir });
    empty.reload();
    expect(await empty.secureContext("x.reoclo.localhost")).toBeInstanceOf(
      (tls.createSecureContext({}) as object).constructor,
    );
  });

  it("reports CA status: missing, trusted, and stale against the config", async () => {
    const issuer = new LeafIssuer({ dir, checkTrusted: () => Promise.resolve(true) });
    expect(await issuer.status([])).toMatchObject({ exists: false, trusted: false, stale: false });
    await createCa(["internal"], { dir });
    expect(await issuer.status(["internal"])).toMatchObject({ exists: true, trusted: true, stale: false, suffixes: ["internal", "reoclo.localhost"] });
    expect((await issuer.status(["internal", "corp.example.com"])).stale).toBe(true);
  });

  it("reuses a trust answer within its cache window", async () => {
    await createCa([], { dir });
    let calls = 0;
    const issuer = new LeafIssuer({ dir, trustCacheMs: 60_000, checkTrusted: () => Promise.resolve(++calls > 0) });
    await issuer.status([]);
    await issuer.status([]);
    expect(calls).toBe(1);
    issuer.reload();
    await issuer.status([]);
    expect(calls).toBe(2);
  });
});
