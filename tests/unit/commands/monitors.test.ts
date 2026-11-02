import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  registerMonitors,
  parseExpectStatus,
  parseMethod,
  parseHeaderFlag,
  buildMonitorBody,
  duplicateMonitorHint,
} from "../../../src/commands/monitors";

function monitorsCmd(): Command {
  const p = new Command();
  registerMonitors(p);
  return p.commands.find((c) => c.name() === "monitors")!;
}

const FIELD_FLAGS = [
  "--check-path",
  "--method",
  "--timeout",
  "--expect-status",
  "--must-contain",
  "--header",
];

describe("reoclo monitors", () => {
  test("registers all subcommands", () => {
    const names = monitorsCmd().commands.map((c) => c.name());
    expect(names.sort()).toEqual(
      ["create", "get", "ls", "pause", "resume", "rm", "update"].sort(),
    );
  });

  test("create exposes --name, --url and the full field set", () => {
    const create = monitorsCmd().commands.find((c) => c.name() === "create")!;
    const flags = create.options.map((o) => o.long);
    expect(flags).toContain("--name");
    expect(flags).toContain("--url");
    for (const f of ["--interval", ...FIELD_FLAGS]) expect(flags).toContain(f);
  });

  test("update exposes the full field set", () => {
    const update = monitorsCmd().commands.find((c) => c.name() === "update")!;
    const flags = update.options.map((o) => o.long);
    for (const f of ["--name", "--url", "--interval", ...FIELD_FLAGS]) expect(flags).toContain(f);
  });
});

describe("parseExpectStatus", () => {
  test("single status → min=max", () => {
    expect(parseExpectStatus("200")).toEqual({
      expected_status_min: 200,
      expected_status_max: 200,
    });
  });
  test("range", () => {
    expect(parseExpectStatus("200-299")).toEqual({
      expected_status_min: 200,
      expected_status_max: 299,
    });
  });
  test("rejects min > max", () => {
    expect(() => parseExpectStatus("299-200")).toThrow();
  });
  test("rejects non-3-digit input", () => {
    expect(() => parseExpectStatus("ok")).toThrow();
    expect(() => parseExpectStatus("20")).toThrow();
  });
});

describe("parseMethod", () => {
  test("uppercases and accepts known methods", () => {
    expect(parseMethod("get")).toBe("GET");
    expect(parseMethod("POST")).toBe("POST");
  });
  test("rejects an unknown method", () => {
    expect(() => parseMethod("FETCH")).toThrow();
  });
});

describe("parseHeaderFlag", () => {
  test("splits on the first colon and trims", () => {
    expect(parseHeaderFlag("Authorization: Bearer x")).toEqual({
      name: "Authorization",
      value: "Bearer x",
      is_secret: false,
    });
  });
  test("keeps colons in the value", () => {
    expect(parseHeaderFlag("X-Url: https://a.b/c").value).toBe("https://a.b/c");
  });
  test("rejects a missing name", () => {
    expect(() => parseHeaderFlag(": v")).toThrow();
    expect(() => parseHeaderFlag("novalue")).toThrow();
  });
});

describe("buildMonitorBody", () => {
  test("maps flags to API field names, omitting unset ones", () => {
    expect(
      buildMonitorBody({
        name: "api",
        url: "https://api.reoclo.com",
        interval: "60",
        checkPath: "/health",
        method: "head",
        timeout: "10",
        expectStatus: "200-204",
        mustContain: "ok",
        header: ["X-A: 1", "X-B: 2"],
      }),
    ).toEqual({
      name: "api",
      url: "https://api.reoclo.com",
      check_interval_seconds: 60,
      check_path: "/health",
      method: "HEAD",
      timeout_seconds: 10,
      expected_status_min: 200,
      expected_status_max: 204,
      response_must_contain: "ok",
      headers: [
        { name: "X-A", value: "1", is_secret: false },
        { name: "X-B", value: "2", is_secret: false },
      ],
    });
  });

  test("empty header array is omitted (PATCH-safe)", () => {
    expect(buildMonitorBody({ checkPath: "/health", header: [] })).toEqual({
      check_path: "/health",
    });
  });

  test("empty opts → empty body", () => {
    expect(buildMonitorBody({})).toEqual({});
  });
});

describe("duplicateMonitorHint", () => {
  test("points at monitors update with the extracted id", () => {
    const hint = duplicateMonitorHint(
      "A monitor for this URL already exists: api (active, id 5f1c0d2e-1111-2222-3333-444455556666)",
    );
    expect(hint).toBe("Update it with `reoclo monitors update 5f1c0d2e-1111-2222-3333-444455556666`");
  });

  test("a paused monitor is resumed instead", () => {
    const hint = duplicateMonitorHint(
      "A monitor for this URL already exists: api (paused, id abc123)",
    );
    expect(hint).toBe("It is paused. Resume it with `reoclo monitors resume abc123`");
  });

  test("a name with parentheses still parses", () => {
    const hint = duplicateMonitorHint(
      "A monitor for this URL already exists: api (eu) (active, id abc123)",
    );
    expect(hint).toContain("monitors update abc123");
  });

  test("other 400s get no hint", () => {
    expect(duplicateMonitorHint("url must be http or https")).toBeNull();
    expect(duplicateMonitorHint("A monitor for this URL already exists: api")).toBeNull();
  });
});
