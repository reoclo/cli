import { describe, expect, test } from "bun:test";
import { buildAutomationExecBody } from "../../src/commands/exec";

describe("buildAutomationExecBody", () => {
  test("includes server_id, command, run_context and run_id; omits empty env", () => {
    const body = buildAutomationExecBody({
      serverId: "11111111-2222-3333-4444-555555555555",
      command: "docker ps",
      cwd: "/srv",
      env: {},
      timeoutSeconds: 120,
      runId: "9",
      runContext: { provider: "woodpecker", repository: "reoclo/app", workflow: "", trigger: "push", actor: "" },
    });
    expect(body.server_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.command).toBe("docker ps");
    expect(body.working_directory).toBe("/srv");
    expect(body.timeout_seconds).toBe(120);
    expect(body.run_id).toBe("9");
    expect(body.run_context?.provider).toBe("woodpecker");
    expect("env" in body).toBe(false);
  });

  test("includes env when non-empty", () => {
    const body = buildAutomationExecBody({
      serverId: "11111111-2222-3333-4444-555555555555",
      command: "x",
      env: { A: "1" },
    });
    expect(body.env).toEqual({ A: "1" });
  });
});
