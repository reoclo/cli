// src/tunnels/hosts-block.ts
//
// Pure functions for the managed block in /etc/hosts and for the hostname and
// suffix rules the daemon, the CLI and the root helper all share. Nothing here
// touches the filesystem.

export const BLOCK_BEGIN = "# BEGIN reoclo (managed)";
export const BLOCK_END = "# END reoclo";
/** The only addresses an entry can map to. The helper's request has no address field. */
export const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;
/** The suffix every default hostname and the local CA always cover. */
export const BASE_SUFFIX = "reoclo.localhost";
export const MAX_ENTRIES = 512;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/** Single-label suffixes a user may allow. A bare public TLD such as "com" would let a leaked CA key sign for every site under it. */
const RESERVED_SINGLE_LABELS = new Set([
  "example",
  "home",
  "internal",
  "invalid",
  "lan",
  "local",
  "localdomain",
  "localhost",
  "test",
]);

export class HostnameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostnameError";
  }
}

/** True for a lowercase DNS name with at least two labels, 253 characters at most. */
export function isValidHostname(name: string): boolean {
  return name.length <= 253 && HOSTNAME_RE.test(name);
}

/** Throws HostnameError unless `suffix` is a lowercase DNS suffix that is safe to allow. */
export function assertValidSuffix(suffix: string): void {
  if (suffix.length > 253 || !new RegExp(`^${LABEL}(?:\\.${LABEL})*$`).test(suffix)) {
    throw new HostnameError(`invalid suffix ${JSON.stringify(suffix)}: expected a lowercase DNS name such as "internal" or "corp.example.com"`);
  }
  if (!suffix.includes(".") && !RESERVED_SINGLE_LABELS.has(suffix)) {
    throw new HostnameError(
      `suffix "${suffix}" is a single label and could be a public top-level domain; use a reserved name (${[...RESERVED_SINGLE_LABELS].join(", ")}) or a domain you own`,
    );
  }
}

/** True when `host` is `suffix` itself or a subdomain of it. */
export function inSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Every suffix a hostname may use: the base suffix plus the allowlist. */
export function allowedSuffixes(extra: readonly string[]): string[] {
  return [...new Set([BASE_SUFFIX, ...extra])].sort();
}

/** The suffix a hostname falls under, or undefined. */
export function suffixFor(host: string, extra: readonly string[]): string | undefined {
  return allowedSuffixes(extra).find((s) => inSuffix(host, s));
}

/**
 * What the root helper accepts: a valid name that is a subdomain of .localhost,
 * or an allowlisted suffix itself or a subdomain of one, the same rule the CA
 * uses. The allowlist is written at setup time with sudo.
 */
export function validateHelperEntry(host: string, allowlist: readonly string[]): string | undefined {
  if (!isValidHostname(host)) return `${JSON.stringify(host)} is not a valid hostname`;
  if (host.endsWith(".localhost")) return undefined;
  if (allowlist.some((s) => inSuffix(host, s))) return undefined;
  return `${host} does not end in .localhost or an allowed suffix`;
}

/** The text between the markers, markers included, with the file's own line ending. */
export function renderBlock(entries: readonly string[], eol = "\n"): string {
  if (entries.length === 0) return "";
  const lines = [BLOCK_BEGIN];
  for (const host of [...new Set(entries)].sort()) {
    for (const addr of LOOPBACK_ADDRESSES) lines.push(`${addr} ${host}`);
  }
  lines.push(BLOCK_END);
  return lines.join(eol) + eol;
}

export class BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockError";
  }
}

/** The hostnames in the managed block of `text`. */
export function readBlock(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === BLOCK_BEGIN);
  if (begin < 0) return [];
  const end = lines.findIndex((l, i) => i > begin && l.trim() === BLOCK_END);
  if (end < 0) return [];
  const hosts = new Set<string>();
  for (const line of lines.slice(begin + 1, end)) {
    const [, ...names] = line.trim().split(/\s+/);
    for (const n of names) hosts.add(n);
  }
  return [...hosts].sort();
}

/**
 * Put `entries` into the managed block of `text`. Only the lines between the
 * markers change. A missing block is appended; an empty list removes the block.
 * Throws BlockError for a block with a missing or repeated marker, because
 * guessing where it ends could delete someone's lines.
 */
export function replaceBlock(text: string, entries: readonly string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Keep each line's own ending: split after every newline.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const marker = (l: string, m: string): boolean => l.replace(/\r?\n$/, "").trim() === m;
  const begins = lines.flatMap((l, i) => (marker(l, BLOCK_BEGIN) ? [i] : []));
  const ends = lines.flatMap((l, i) => (marker(l, BLOCK_END) ? [i] : []));
  const block = renderBlock(entries, eol);

  if (begins.length === 0 && ends.length === 0) {
    if (block === "") return text;
    const lead = text === "" || text.endsWith("\n") ? "" : eol;
    return text + lead + block;
  }
  if (begins.length !== 1 || ends.length !== 1 || (ends[0] ?? 0) < (begins[0] ?? 0)) {
    throw new BlockError(
      `the reoclo block in the hosts file is damaged (expected one "${BLOCK_BEGIN}" line followed by one "${BLOCK_END}" line); fix or remove it by hand`,
    );
  }
  const from = begins[0] as number;
  const to = ends[0] as number;
  return [...lines.slice(0, from), block, ...lines.slice(to + 1)].join("");
}
