import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerFindings } from "../../../src/commands/findings";
import { getCompletionSpec, getRequiredCapability } from "../../../src/client/command-meta";

function findingsCmd(): Command {
  const p = new Command();
  registerFindings(p);
  return p.commands.find((c) => c.name() === "findings")!;
}

function sub(name: string): Command {
  return findingsCmd().commands.find((c) => c.name() === name)!;
}

describe("reoclo findings", () => {
  test("registers list, get, ack and resolve", () => {
    const names = findingsCmd().commands.map((c) => c.name()).sort();
    expect(names).toEqual(["ack", "get", "list", "resolve"]);
  });

  test("list defaults to open findings and filters by severity, app and server", () => {
    const list = sub("list");
    const state = list.options.find((o) => o.long === "--state")!;
    expect(state.defaultValue).toBe("open");
    const flags = list.options.map((o) => o.long);
    for (const flag of ["--status", "--severity", "--category", "--app", "--server", "--limit"]) {
      expect(flags).toContain(flag);
    }
  });

  test("list completes states, severities and resources", () => {
    const spec = getCompletionSpec(sub("list"));
    expect(spec?.flags?.["--state"]).toEqual({
      enum: ["open", "acknowledged", "resolved", "muted", "all"],
    });
    expect(spec?.flags?.["--severity"]).toEqual({
      enum: ["info", "low", "medium", "high", "critical"],
    });
    expect(spec?.flags?.["--app"]).toBe("apps");
    expect(spec?.flags?.["--server"]).toBe("servers");
  });

  test("reading needs watch:findings:read and changing needs watch:findings:write", () => {
    expect(getRequiredCapability(sub("list"))).toBe("watch:findings:read");
    expect(getRequiredCapability(sub("get"))).toBe("watch:findings:read");
    expect(getRequiredCapability(sub("ack"))).toBe("watch:findings:write");
    expect(getRequiredCapability(sub("resolve"))).toBe("watch:findings:write");
  });
});
