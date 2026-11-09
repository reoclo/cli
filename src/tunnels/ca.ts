// src/tunnels/ca.ts
//
// The per-machine certificate authority for local HTTPS, and the leaf
// certificates the TLS proxy serves.
//
// The CA is ECDSA P-256, valid for two years, with a critical name constraint
// limited to reoclo.localhost plus the user's allowlisted suffixes. If its key
// ever leaks, it cannot sign for any other domain. Leaves are minted per
// hostname on first use, valid 30 days, renewed after two thirds of that, and
// kept in memory only.
//
// Certificates come from @peculiar/x509, which is pure TypeScript and runs in a
// compiled Bun binary, so nothing here shells out to openssl. The library has
// no name-constraints builder, so the extension is built as raw DER.

import type * as X509 from "@peculiar/x509";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import tls from "node:tls";
import { BASE_SUFFIX, allowedSuffixes, inSuffix } from "./hosts-block";
import { caCertFile, caDir, caKeyFile } from "./paths";

// tsyringe, inside @peculiar/x509, throws at load unless the reflect polyfill has
// already run. Static imports do not guarantee that once the CLI is bundled, so
// these load in sequence.
await import("reflect-metadata");
const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const NAME_CONSTRAINTS_OID = "2.5.29.30";
const DAY_MS = 86_400_000;
export const CA_VALIDITY_DAYS = 730;
export const LEAF_VALIDITY_DAYS = 30;
/** Notbefore is backdated so a slightly slow clock does not reject a fresh certificate. */
const BACKDATE_MS = 5 * 60_000;

export const CA_COMMON_NAME = "Reoclo Local CA";

function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  return Buffer.concat([Uint8Array.of(tag), derLength(body.length), body]);
}

/**
 * NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees }, where
 * each subtree is SEQUENCE { dNSName [2] }. Lengths use the long form once the
 * content passes 127 bytes, which several suffixes will.
 */
export function buildNameConstraints(suffixes: readonly string[]): Uint8Array<ArrayBuffer> {
  const subtrees = suffixes.map((s) => tlv(0x30, tlv(0x82, Buffer.from(s, "ascii"))));
  return new Uint8Array(tlv(0x30, tlv(0xa0, ...subtrees)));
}

function readTlv(buf: Uint8Array, at: number): { tag: number; start: number; end: number } {
  const tag = buf[at];
  let len = buf[at + 1];
  if (tag === undefined || len === undefined) throw new Error("truncated DER");
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[start + i] ?? 0);
    start += n;
  }
  if (start + len > buf.length) throw new Error("truncated DER");
  return { tag, start, end: start + len };
}

/** The permitted dNSName subtrees in a NameConstraints value. */
export function parseNameConstraints(der: Uint8Array): string[] {
  const outer = readTlv(der, 0);
  if (outer.tag !== 0x30) throw new Error("name constraints: expected a SEQUENCE");
  const out: string[] = [];
  for (let at = outer.start; at < outer.end; ) {
    const field = readTlv(der, at);
    if (field.tag === 0xa0) {
      for (let sub = field.start; sub < field.end; ) {
        const tree = readTlv(der, sub);
        const name = readTlv(der, tree.start);
        if (name.tag === 0x82) out.push(Buffer.from(der.subarray(name.start, name.end)).toString("ascii"));
        sub = tree.end;
      }
    }
    at = field.end;
  }
  return out;
}

function pem(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function unpem(text: string): Buffer {
  return Buffer.from(text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

function serial(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[0] = ((b[0] ?? 0) & 0x7f) | 0x10;
  return Buffer.from(b).toString("hex");
}

async function exportKey(key: CryptoKey): Promise<string> {
  return pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", key));
}

async function importKey(text: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", new Uint8Array(unpem(text)), ALG, true, ["sign"]);
}

export interface CaFiles {
  cert: string;
  key: string;
}

export interface CaInfo {
  /** The CA certificate, PEM. */
  certPem: string;
  /** Suffixes the name constraint permits. */
  suffixes: string[];
  notBefore: Date;
  notAfter: Date;
  /** SHA-1 of the DER, upper-case hex: how macOS keychain tools name a certificate. */
  sha1: string;
}

export interface LoadedCa extends CaInfo {
  cert: X509.X509Certificate;
  signingKey: CryptoKey;
}

export interface CaOptions {
  /** Defaults to the state directory's ca/. */
  dir?: string;
  now?: () => Date;
}

function files(dir: string | undefined): CaFiles {
  return dir === undefined ? { cert: caCertFile(), key: caKeyFile() } : { cert: `${dir}/ca.pem`, key: `${dir}/ca.key` };
}

function describe(cert: X509.X509Certificate, certPem: string): CaInfo {
  const ext = cert.extensions.find((e) => e.type === NAME_CONSTRAINTS_OID);
  return {
    certPem,
    suffixes: ext ? parseNameConstraints(new Uint8Array(ext.value)) : [],
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    sha1: createHash("sha1").update(Buffer.from(cert.rawData)).digest("hex").toUpperCase(),
  };
}

/** Read the CA's public details without touching its key. Undefined when there is no CA. */
export function readCaInfo(opts: CaOptions = {}): CaInfo | undefined {
  const f = files(opts.dir);
  if (!existsSync(f.cert)) return undefined;
  const certPem = readFileSync(f.cert, "utf8");
  return describe(new x509.X509Certificate(certPem), certPem);
}

/** Load the CA with its signing key. Undefined when either file is missing. */
export async function loadCa(opts: CaOptions = {}): Promise<LoadedCa | undefined> {
  const f = files(opts.dir);
  if (!existsSync(f.cert) || !existsSync(f.key)) return undefined;
  const certPem = readFileSync(f.cert, "utf8");
  const cert = new x509.X509Certificate(certPem);
  return { ...describe(cert, certPem), cert, signingKey: await importKey(readFileSync(f.key, "utf8")) };
}

/** Make a new CA and write ca.pem and ca.key (mode 0600). Replaces any CA already there. */
export async function createCa(extraSuffixes: readonly string[], opts: CaOptions = {}): Promise<LoadedCa> {
  const now = (opts.now ?? (() => new Date()))();
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const suffixes = allowedSuffixes(extraSuffixes);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=${CA_COMMON_NAME}, O=Reoclo`,
    notBefore: new Date(now.getTime() - BACKDATE_MS),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false),
      new x509.Extension(NAME_CONSTRAINTS_OID, true, buildNameConstraints(suffixes)),
    ],
  });
  const dir = opts.dir ?? caDir();
  const f = files(opts.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const certPem = cert.toString("pem");
  writeFileSync(f.key, await exportKey(keys.privateKey), { mode: 0o600 });
  chmodSync(f.key, 0o600);
  writeFileSync(f.cert, certPem, { mode: 0o644 });
  return { ...describe(cert, certPem), cert, signingKey: keys.privateKey };
}

export interface EnsureResult {
  ca: LoadedCa;
  /** "created" for a first CA, "reissued" when the suffixes changed, "unchanged" otherwise. */
  change: "created" | "reissued" | "unchanged";
  /** The CA that was replaced, so its trust can be removed first. */
  previous?: CaInfo;
}

/** True when the CA's constraint equals the suffixes the config asks for. */
export function suffixesMatch(ca: CaInfo, extraSuffixes: readonly string[]): boolean {
  const want = allowedSuffixes(extraSuffixes);
  return want.length === ca.suffixes.length && want.every((s, i) => s === [...ca.suffixes].sort()[i]);
}

/** Keep the CA the config describes: create it, re-issue it when the suffixes changed, or leave it. */
export async function ensureCa(extraSuffixes: readonly string[], opts: CaOptions = {}): Promise<EnsureResult> {
  const existing = await loadCa(opts);
  if (existing && suffixesMatch(existing, extraSuffixes)) return { ca: existing, change: "unchanged" };
  const ca = await createCa(extraSuffixes, opts);
  return existing ? { ca, change: "reissued", previous: existing } : { ca, change: "created" };
}

export function removeCa(opts: CaOptions = {}): void {
  rmSync(opts.dir ?? caDir(), { recursive: true, force: true });
}

export interface Leaf {
  hostname: string;
  certPem: string;
  keyPem: string;
  notBefore: Date;
  notAfter: Date;
}

/** Mint a leaf for one hostname. Throws when the CA's name constraint would not cover it. */
export async function mintLeaf(ca: LoadedCa, hostname: string, now: Date = new Date()): Promise<Leaf> {
  if (!ca.suffixes.some((s) => inSuffix(hostname, s))) {
    throw new Error(
      `the local CA does not cover ${hostname} (it permits ${ca.suffixes.join(", ")}); run: reoclo tunnel trust --domain <suffix>`,
    );
  }
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const notBefore = new Date(now.getTime() - BACKDATE_MS);
  const notAfter = new Date(now.getTime() + LEAF_VALIDITY_DAYS * DAY_MS);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: `CN=${hostname}`,
    issuer: ca.cert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: ca.signingKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: hostname }], false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false),
      await x509.AuthorityKeyIdentifierExtension.create(ca.cert, false),
    ],
  });
  return { hostname, certPem: cert.toString("pem"), keyPem: await exportKey(keys.privateKey), notBefore, notAfter };
}

/** A leaf is renewed once two thirds of its lifetime has passed. */
export function leafNeedsRenewal(leaf: Pick<Leaf, "notBefore" | "notAfter">, now: Date): boolean {
  const life = leaf.notAfter.getTime() - leaf.notBefore.getTime();
  return now.getTime() >= leaf.notBefore.getTime() + (life * 2) / 3;
}

export interface CaStatus {
  exists: boolean;
  trusted: boolean;
  not_after?: string;
  suffixes: string[];
  /** The config asks for suffixes the CA does not cover; run `reoclo tunnel trust` again. */
  stale: boolean;
  path?: string;
}

/** What the TLS proxy needs: a secure context per hostname, and the CA's state for status. */
export interface CertSource {
  secureContext(hostname: string): Promise<tls.SecureContext>;
  status(configSuffixes: readonly string[]): Promise<CaStatus>;
  /** Forget the loaded CA and every leaf: the files on disk changed. */
  reload(): void;
}

export interface LeafIssuerOptions extends CaOptions {
  /** Whether the CA is in the system trust store. Injected so tests and status never run `security`. */
  checkTrusted?: (ca: CaInfo) => Promise<boolean>;
  /** How long a trust answer is reused. Default 60 s. */
  trustCacheMs?: number;
}

export class LeafIssuer implements CertSource {
  private ca?: Promise<LoadedCa | undefined>;
  private readonly leaves = new Map<string, { leaf: Leaf; context: tls.SecureContext } | Promise<unknown>>();
  private trust?: { sha1: string; at: number; value: boolean };

  constructor(private readonly opts: LeafIssuerOptions = {}) {}

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  reload(): void {
    this.ca = undefined;
    this.leaves.clear();
    this.trust = undefined;
  }

  private loadCa(): Promise<LoadedCa | undefined> {
    this.ca ??= loadCa(this.opts);
    return this.ca;
  }

  /** The leaf for `hostname`, minted or renewed as needed. */
  async leaf(hostname: string): Promise<Leaf> {
    const cached = this.leaves.get(hostname);
    if (cached && !(cached instanceof Promise) && !leafNeedsRenewal(cached.leaf, this.now())) return cached.leaf;
    return (await this.entry(hostname)).leaf;
  }

  private async entry(hostname: string): Promise<{ leaf: Leaf; context: tls.SecureContext }> {
    const cached = this.leaves.get(hostname);
    if (cached instanceof Promise) return cached as Promise<{ leaf: Leaf; context: tls.SecureContext }>;
    if (cached && !leafNeedsRenewal(cached.leaf, this.now())) return cached;
    const pending = (async () => {
      const ca = await this.loadCa();
      if (!ca) throw new Error("there is no local CA yet; run: reoclo tunnel trust");
      const leaf = await mintLeaf(ca, hostname, this.now());
      return { leaf, context: tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem }) };
    })();
    this.leaves.set(hostname, pending);
    try {
      const made = await pending;
      this.leaves.set(hostname, made);
      return made;
    } catch (err) {
      this.leaves.delete(hostname);
      throw err;
    }
  }

  async secureContext(hostname: string): Promise<tls.SecureContext> {
    return (await this.entry(hostname)).context;
  }

  async status(configSuffixes: readonly string[]): Promise<CaStatus> {
    const info = readCaInfo(this.opts);
    if (!info) return { exists: false, trusted: false, suffixes: allowedSuffixes(configSuffixes), stale: false };
    let trusted = false;
    const check = this.opts.checkTrusted;
    if (check) {
      const ttl = this.opts.trustCacheMs ?? 60_000;
      const t = Date.now();
      if (this.trust && this.trust.sha1 === info.sha1 && t - this.trust.at < ttl) trusted = this.trust.value;
      else {
        trusted = await check(info).catch(() => false);
        this.trust = { sha1: info.sha1, at: t, value: trusted };
      }
    }
    return {
      exists: true,
      trusted,
      not_after: info.notAfter.toISOString(),
      suffixes: info.suffixes,
      stale: !suffixesMatch(info, configSuffixes),
      path: files(this.opts.dir).cert,
    };
  }
}

export { BASE_SUFFIX };
