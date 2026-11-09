// src/tunnels/ca-actions.ts
//
// Trusting and untrusting the local CA, shared by `reoclo tunnel trust|untrust`
// and the daemon's POST /v1/ca/trust and /untrust. The CA and trust modules load
// on demand, as the CLI always loaded them.

import { assertValidSuffix } from "./hosts-block";
import { caCertFile } from "./paths";

/** The suffixes the CA must cover: the existing ones plus the new ones, each checked. Throws HostnameError. */
export function mergeSuffixList(existing: readonly string[], requested: readonly string[]): string[] {
  for (const s of requested) assertValidSuffix(s);
  return [...new Set([...existing, ...requested])].sort();
}

export interface TrustResult {
  lines: string[];
  suffixes: string[];
}

export interface CaActions {
  trust(suffixes: string[]): Promise<TrustResult>;
  untrust(): Promise<{ lines: string[] }>;
}

export const localCaActions: CaActions = {
  async trust(suffixes) {
    const ca = await import("./ca");
    const trust = await import("./trust");
    const env = trust.defaultTrustEnv();
    const certPath = caCertFile();
    const lines: string[] = [];

    const before = ca.readCaInfo();
    if (before && !ca.suffixesMatch(before, suffixes)) {
      lines.push("the allowed suffixes changed, so the old CA is replaced");
      await trust.removeTrust(env, { certPath, sha1: before.sha1 });
    }
    const { ca: current, change } = await ca.ensureCa(suffixes);
    const target = { certPath, certPem: current.certPem, sha1: current.sha1 };

    if (change === "unchanged" && (await trust.checkTrust(env, target))) {
      lines.push(`the local CA is already trusted (${certPath})`);
    } else {
      lines.push(`${change === "unchanged" ? "trusting" : "created"} the local CA at ${certPath}`);
      lines.push(...(await trust.installTrust(env, target)));
    }
    return { lines, suffixes: current.suffixes };
  },

  async untrust() {
    const ca = await import("./ca");
    const trust = await import("./trust");
    const info = ca.readCaInfo();
    if (!info) return { lines: ["there is no local CA"] };
    const lines = [...(await trust.removeTrust(trust.defaultTrustEnv(), { certPath: caCertFile(), sha1: info.sha1 }))];
    ca.removeCa();
    lines.push("deleted the CA and its key");
    return { lines };
  },
};
