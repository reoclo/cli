import { describe, expect, test } from "bun:test";
import {
  TERMINAL_GROUP_STATUSES,
  fmtDurationMs,
  fmtDurationS,
  matchGroup,
  matchGroupDeployment,
  memberForService,
  serviceRows,
  stageRows,
  type GroupDeploymentRead,
  type GroupRead,
  type MemberApp,
} from "../../../src/commands/groups";

const GROUPS: GroupRead[] = [
  { id: "g-1", name: "Portfolio", slug: "portfolio", kind: "compose", server_id: "s-1" },
  { id: "g-2", name: "Lab", slug: "stack-lab", kind: "compose", server_id: "s-1" },
];

const DEPLOYMENTS: GroupDeploymentRead[] = [
  { id: "gd-3", deployment_number: 3, status: "succeeded" },
  { id: "gd-2", deployment_number: 2, status: "failed" },
];

describe("matchGroup", () => {
  test("matches by slug and by id", () => {
    expect(matchGroup(GROUPS, "portfolio")?.id).toBe("g-1");
    expect(matchGroup(GROUPS, "g-2")?.slug).toBe("stack-lab");
  });

  test("returns undefined for unknown refs", () => {
    expect(matchGroup(GROUPS, "nope")).toBeUndefined();
  });
});

describe("matchGroupDeployment", () => {
  test("matches by id, then by deployment number", () => {
    expect(matchGroupDeployment(DEPLOYMENTS, "gd-2")?.deployment_number).toBe(2);
    expect(matchGroupDeployment(DEPLOYMENTS, "3")?.id).toBe("gd-3");
  });

  test("non-integer refs do not match numbers", () => {
    expect(matchGroupDeployment(DEPLOYMENTS, "3.5")).toBeUndefined();
    expect(matchGroupDeployment(DEPLOYMENTS, "latest")).toBeUndefined();
  });
});

describe("memberForService", () => {
  const APPS: MemberApp[] = [
    { id: "a-1", group_id: "g-1", build: { compose_service: "backend" } },
    { id: "a-2", group_id: "g-1", build: { compose_service: "frontend" } },
    { id: "a-3", group_id: "g-2", build: { compose_service: "backend" } },
    { id: "a-4", group_id: null, build: { compose_service: "backend" } },
  ];

  test("matches within the group only", () => {
    expect(memberForService(APPS, "g-1", "backend")?.id).toBe("a-1");
    expect(memberForService(APPS, "g-2", "backend")?.id).toBe("a-3");
    expect(memberForService(APPS, "g-1", "db")).toBeUndefined();
  });
});

describe("duration formatting", () => {
  test("sub-minute and minute forms", () => {
    expect(fmtDurationS(2.34)).toBe("2.3s");
    expect(fmtDurationS(42)).toBe("42s");
    expect(fmtDurationS(100)).toBe("1m40s");
    expect(fmtDurationMs(2314)).toBe("2.3s");
  });

  test("missing values render empty", () => {
    expect(fmtDurationS(null)).toBe("");
    expect(fmtDurationMs(undefined)).toBe("");
  });
});

describe("row shaping", () => {
  test("stageRows keeps order and fills blanks", () => {
    const rows = stageRows([
      { name: "build", status: "succeeded", duration_ms: 2314 },
      { name: "up", status: "failed", error_message: "boom" },
    ]);
    expect(rows).toEqual([
      { stage: "build", status: "succeeded", duration: "2.3s", error: "" },
      { stage: "up", status: "failed", duration: "", error: "boom" },
    ]);
  });

  test("serviceRows surfaces action, status, and child deployment", () => {
    const rows = serviceRows([
      {
        compose_service: "backend",
        planned_action: "build",
        status: "failed",
        reason: "build context changed: app/",
        deployment_id: "d-1",
      },
    ]);
    expect(rows[0]).toEqual({
      service: "backend",
      action: "build",
      status: "failed",
      reason: "build context changed: app/",
      deployment: "d-1",
    });
  });
});

describe("terminal statuses", () => {
  test("covers every terminal state and no live ones", () => {
    for (const s of ["succeeded", "failed", "partial", "cancelled"]) {
      expect(TERMINAL_GROUP_STATUSES.has(s)).toBe(true);
    }
    expect(TERMINAL_GROUP_STATUSES.has("running")).toBe(false);
    expect(TERMINAL_GROUP_STATUSES.has("pending")).toBe(false);
  });
});

import { TERMINAL_TASK_RUN_STATUSES, taskRunSummary, type GroupTaskRunRead } from "../../../src/commands/groups";

describe("task runs (REO-348 CLI)", () => {
  test("terminal statuses are exactly succeeded and failed", () => {
    expect(TERMINAL_TASK_RUN_STATUSES.has("succeeded")).toBe(true);
    expect(TERMINAL_TASK_RUN_STATUSES.has("failed")).toBe(true);
    expect(TERMINAL_TASK_RUN_STATUSES.has("running")).toBe(false);
    expect(TERMINAL_TASK_RUN_STATUSES.has("pending")).toBe(false);
  });

  test("taskRunSummary renders the row shape", () => {
    const run: GroupTaskRunRead = {
      id: "run-12345678",
      compose_service: "minio-init",
      status: "succeeded",
      exit_code: 0,
      created_at: "2026-09-01T10:00:00Z",
      duration_seconds: 4,
      error_message: null,
    };
    expect(taskRunSummary(run)).toEqual({
      id: "run-1234",
      service: "minio-init",
      status: "succeeded",
      exit: 0,
      started: "2026-09-01 10:00:00",
      duration: "4.0s",
      error: "",
    });
  });
});
