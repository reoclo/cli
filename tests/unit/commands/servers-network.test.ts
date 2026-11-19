import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerServers } from "../../../src/commands/servers";
import { explainConflict, parseNetworkMode } from "../../../src/commands/servers-network";
import { getCompletionSpec } from "../../../src/client/command-meta";
import { ApiError } from "../../../src/client/errors";

function networkGroup(): Command {
  const root = new Command();
  registerServers(root);
  return root.commands.find((c) => c.name() === "servers")!.commands.find((c) => c.name() === "network")!;
}

describe("servers network surface", () => {
  test("registers show, set and reapply, each completing the server", () => {
    const group = networkGroup();
    expect(group.commands.map((c) => c.name()).sort()).toEqual(["reapply", "set", "show"]);
    for (const cmd of group.commands) {
      expect(getCompletionSpec(cmd)?.args).toEqual([{ slot: 0, resource: "servers" }]);
    }
  });

  test("set has a --yes flag", () => {
    const set = networkGroup().commands.find((c) => c.name() === "set")!;
    expect(set.options.map((o) => o.long)).toContain("--yes");
  });

  test("set rejects an unknown mode with exit 2 before any request", async () => {
    const root = new Command();
    registerServers(root);
    const err = await root.parseAsync(["node", "reoclo", "servers", "network", "set", "web1", "bogus"]).catch((e: unknown) => e);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
  });
});

describe("parseNetworkMode", () => {
  test("accepts public and both spellings of tunnels-only", () => {
    expect(parseNetworkMode("public")).toBe("public");
    expect(parseNetworkMode("tunnels-only")).toBe("tunnels_only");
    expect(parseNetworkMode("tunnels_only")).toBe("tunnels_only");
  });
});

describe("explainConflict", () => {
  const conflict = (code: string): ApiError => new ApiError(409, code, "/p");

  test("lists the blockers behind network_access_blocked", async () => {
    const err = (await explainConflict(conflict("network_access_blocked"), () =>
      Promise.resolve([{ kind: "domain" as const, label: "app.example.com", href: null }]),
    )) as ApiError;
    expect(err.status).toBe(409);
    expect(err.message).toContain("tunnels-only");
    expect(err.hint).toContain("domain: app.example.com");
  });

  test("still explains the conflict when the blockers cannot be read", async () => {
    const err = (await explainConflict(conflict("network_access_blocked"), () =>
      Promise.reject(new Error("offline")),
    )) as ApiError;
    expect(err.hint).toContain("reoclo servers network show");
  });

  test.each(["runner_required", "runner_outdated"])("explains %s", async (code) => {
    const err = (await explainConflict(conflict(code), () => Promise.resolve([]))) as ApiError;
    expect(err.message).toContain("runner");
    expect(err.message).not.toBe(code);
  });

  test("passes other errors through", async () => {
    const other = new ApiError(500, "boom", "/p");
    expect(await explainConflict(other, () => Promise.resolve([]))).toBe(other);
    const unknown409 = conflict("something_else");
    expect(await explainConflict(unknown409, () => Promise.resolve([]))).toBe(unknown409);
  });
});
