import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerApps, deepMerge } from "../../../src/commands/apps";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("apps config subgroup", () => {
  test("registers config subgroup with get and set", () => {
    const program = new Command().name("reoclo");
    registerApps(program);
    const apps = program.commands.find((c) => c.name() === "apps")!;
    const config = apps.commands.find((c) => c.name() === "config");
    expect(config).toBeDefined();
    const names = config!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["get", "set"]);
  });

  test("apps config get has withCompletion(slot 0 → apps)", () => {
    const program = new Command().name("reoclo");
    registerApps(program);
    const get = program.commands
      .find((c) => c.name() === "apps")!
      .commands.find((c) => c.name() === "config")!
      .commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "apps" }]);
  });

  test("apps config set has all 7 documented flags", () => {
    const program = new Command().name("reoclo");
    registerApps(program);
    const set = program.commands
      .find((c) => c.name() === "apps")!
      .commands.find((c) => c.name() === "config")!
      .commands.find((c) => c.name() === "set")!;
    const longs = set.options.map((o) => o.long);
    for (const flag of ["--buildpack", "--docker-image", "--container-port", "--host-port", "--replicas", "--env", "--set"]) {
      expect(longs).toContain(flag);
    }
  });
});

describe("deepMerge (apps config set)", () => {
  test("a partial build change preserves the other build fields", () => {
    // The REO-109 hazard: the server replaces the whole build slice, so the CLI
    // must send the complete object. A partial --docker-image must not wipe
    // build_pack / compose_* / etc.
    const current = {
      build: {
        build_pack: "docker_image",
        docker_image: "minio/minio:latest",
        compose_file_path: "docker-compose.yml",
        base_directory: ".",
      },
      deploy: { container_port: 9000, host_port: 9000, replicas: 1 },
    };
    const merged = deepMerge(current, { build: { docker_image: "redis:7" } });
    expect(merged).toEqual({
      build: {
        build_pack: "docker_image",
        docker_image: "redis:7",
        compose_file_path: "docker-compose.yml",
        base_directory: ".",
      },
      deploy: { container_port: 9000, host_port: 9000, replicas: 1 },
    });
  });

  test("merges nested objects rather than replacing them", () => {
    const merged = deepMerge(
      { deploy: { health_check: { type: "none", interval_seconds: 30 } } },
      { deploy: { health_check: { type: "http" } } },
    );
    expect(merged).toEqual({
      deploy: { health_check: { type: "http", interval_seconds: 30 } },
    });
  });

  test("does not mutate the inputs", () => {
    const base = { build: { docker_image: "a" } };
    const patch = { build: { docker_image: "b" } };
    const merged = deepMerge(base, patch);
    expect(base.build.docker_image).toBe("a");
    expect(merged).not.toBe(base);
    expect((merged.build as { docker_image: string }).docker_image).toBe("b");
  });

  test("a scalar replaces an object and vice versa (no silent merge across types)", () => {
    expect(deepMerge({ x: { a: 1 } }, { x: 5 })).toEqual({ x: 5 });
    expect(deepMerge({ x: 5 }, { x: { a: 1 } })).toEqual({ x: { a: 1 } });
  });
})
