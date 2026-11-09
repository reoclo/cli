// src/tunnels/setup.ts
//
// `reoclo tunnel setup`: the one-time steps that prepare a machine for tunnels,
// in order. A step that is already done is left alone, and a step that fails
// does not stop the others. The steps themselves live with their own commands;
// this module decides which to run and reports what happened.

import type { DaemonStatus } from "./control-client";

export type SetupStepName = "service" | "trust" | "hosts";
export type SetupOutcome = "done" | "already" | "skipped" | "failed";

export interface SetupStepResult {
  step: SetupStepName;
  outcome: SetupOutcome;
  detail: string;
}

export interface SetupOptions {
  service: boolean;
  trust: boolean;
  hosts: boolean;
  domains: string[];
  port443: boolean;
}

export interface SetupDeps {
  /** True when a sudo or keychain prompt can reach the person. */
  interactive: boolean;
  serviceInstalled(): boolean;
  installService(): string;
  /** The daemon's status, or undefined when it cannot be reached. */
  status(): Promise<DaemonStatus | undefined>;
  trust(domains: string[]): Promise<string[]>;
  installHosts(o: { domains: string[]; port443: boolean }): Promise<string[]>;
  /** Says what is about to happen, so a password prompt has context. */
  progress(message: string): void;
}

export interface SetupReport {
  steps: SetupStepResult[];
  status?: DaemonStatus;
  ok: boolean;
}

function coversAll(have: readonly string[], want: readonly string[]): boolean {
  return want.every((d) => have.includes(d));
}

export function trustNeeded(status: DaemonStatus | undefined, domains: readonly string[]): boolean {
  const ca = status?.ca;
  return !ca || !ca.exists || !ca.trusted || ca.stale || !coversAll(ca.suffixes, domains);
}

export function hostsNeeded(
  status: DaemonStatus | undefined,
  domains: readonly string[],
  port443: boolean,
): boolean {
  const hosts = status?.hosts;
  return !hosts || !hosts.installed || !coversAll(hosts.suffixes, domains) || (port443 && !hosts.relay.enabled);
}

async function attempt(step: SetupStepName, fn: () => string | Promise<string>): Promise<SetupStepResult> {
  try {
    return { step, outcome: "done", detail: await fn() };
  } catch (err) {
    return { step, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

function skipped(step: SetupStepName, detail: string): SetupStepResult {
  return { step, outcome: "skipped", detail };
}

const NEEDS_TERMINAL = "needs a terminal for its prompt; run reoclo tunnel setup in one";

export async function runSetup(deps: SetupDeps, opts: SetupOptions): Promise<SetupReport> {
  const steps: SetupStepResult[] = [];

  if (!opts.service) {
    steps.push(skipped("service", "left as it is (--no-service)"));
  } else {
    let installed: SetupStepResult | undefined;
    try {
      if (deps.serviceInstalled()) installed = { step: "service", outcome: "already", detail: "the daemon starts at login" };
    } catch (err) {
      installed = { step: "service", outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (installed) {
      steps.push(installed);
    } else {
      deps.progress("starting the tunnel daemon at login");
      steps.push(await attempt("service", () => deps.installService()));
    }
  }

  const before = await deps.status();

  if (!opts.trust) {
    steps.push(skipped("trust", "left as it is (--no-trust)"));
  } else if (!trustNeeded(before, opts.domains)) {
    steps.push({ step: "trust", outcome: "already", detail: "the local CA is trusted" });
  } else if (!deps.interactive) {
    steps.push(skipped("trust", NEEDS_TERMINAL));
  } else {
    deps.progress("trusting the local CA (your system may ask you to approve this)");
    steps.push(await attempt("trust", async () => (await deps.trust(opts.domains)).join("; ")));
  }

  if (!opts.hosts) {
    steps.push(skipped("hosts", "left as it is (--no-hosts)"));
  } else if (!hostsNeeded(before, opts.domains, opts.port443)) {
    steps.push({ step: "hosts", outcome: "already", detail: "the hosts helper is installed" });
  } else if (!deps.interactive) {
    steps.push(skipped("hosts", NEEDS_TERMINAL));
  } else {
    deps.progress("installing the hosts helper (sudo will ask for your password)");
    steps.push(
      await attempt("hosts", async () =>
        (await deps.installHosts({ domains: opts.domains, port443: opts.port443 })).join("; "),
      ),
    );
  }

  const status = await deps.status();
  return { steps, ...(status ? { status } : {}), ok: steps.every((s) => s.outcome !== "failed") };
}

/** What else the machine needs, as label and text pairs. Nothing here is changed by setup. */
export function readiness(status: DaemonStatus | undefined): [string, string][] {
  if (!status) return [["daemon", "could not be reached; see reoclo tunnel daemon logs"]];
  const out: [string, string][] = [];
  if (status.signed_in !== undefined) {
    out.push(["sign-in", status.signed_in ? "signed in" : "not signed in; run reoclo login"]);
  }
  if (status.https) {
    out.push(["https urls", status.hosts?.relay.listening ? "no port needed" : `use port ${status.https.port}`]);
  }
  const ts = status.tailscale;
  if (ts) {
    const text = !ts.installed
      ? "not installed; only --via tailscale and tunnel share need it"
      : ts.running
        ? `connected${ts.tailnet ? ` to ${ts.tailnet}` : ""}`
        : "installed but not running; only --via tailscale and tunnel share need it";
    out.push(["tailscale", text]);
  }
  return out;
}
