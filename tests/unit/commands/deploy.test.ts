import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDeployments,
  discoverFromCompose,
  parseServicesList,
  summarizeSync,
  type DiscoveredService,
} from "../../../src/commands/deploy";
import type { DeploySyncResponse, DeploySyncResponseItem } from "../../../src/ci/deploy-client";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reoclo-compose-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function compose(body: string): string {
  const p = join(dir, "docker-compose.yml");
  writeFileSync(p, body);
  return p;
}

describe("discoverFromCompose", () => {
  test("includes services on the reoclo-proxy network; container_name falls back to the service key", async () => {
    const p = compose(`
services:
  api:
    networks: [reoclo-proxy]
    expose: ["3000"]
`);
    const out = await discoverFromCompose(p);
    expect(out).toEqual([{ container_name: "api", container_port: 3000, image_tag: null }]);
  });

  test("includes services with the reoclo.managed label (array and map forms)", async () => {
    const arr = await discoverFromCompose(
      compose(`
services:
  w:
    container_name: worker
    image: acme/worker:1
    labels: ["reoclo.managed=true"]
    ports: ["8080:80"]
`),
    );
    expect(arr).toEqual([{ container_name: "worker", container_port: 80, image_tag: "acme/worker:1" }]);

    const map = await discoverFromCompose(
      compose(`
services:
  w:
    networks:
      reoclo-proxy: {}
    ports:
      - target: 5000
        published: 8080
`),
    );
    expect(map).toEqual([{ container_name: "w", container_port: 5000, image_tag: null }]);
  });

  test("excludes services that are neither on the network nor labelled", async () => {
    const out = await discoverFromCompose(
      compose(`
services:
  unmanaged:
    image: nginx
    ports: ["80:80"]
`),
    );
    expect(out).toEqual([]);
  });

  test("skips a managed service that has no resolvable port", async () => {
    const out = await discoverFromCompose(
      compose(`
services:
  noport:
    networks: [reoclo-proxy]
  good:
    networks: [reoclo-proxy]
    ports: [9000]
`),
    );
    expect(out).toEqual([{ container_name: "good", container_port: 9000, image_tag: null }]);
  });

  test("returns [] when the file has no services", async () => {
    expect(await discoverFromCompose(compose("version: '3'\n"))).toEqual([]);
  });

  test("throws exit-2 on a missing file", async () => {
    try {
      await discoverFromCompose(join(dir, "does-not-exist.yml"));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  test("throws exit-2 on malformed YAML", async () => {
    try {
      await discoverFromCompose(compose("services:\n  a: [unterminated\n"));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });
});

describe("parseServicesList", () => {
  test("parses name:port pairs, trimming whitespace", () => {
    expect(parseServicesList("api:3000, web:8080 ")).toEqual([
      { container_name: "api", container_port: 3000, image_tag: null },
      { container_name: "web", container_port: 8080, image_tag: null },
    ]);
  });

  test("ignores empty entries", () => {
    expect(parseServicesList("")).toEqual([]);
    expect(parseServicesList("api:3000,,")).toEqual([
      { container_name: "api", container_port: 3000, image_tag: null },
    ]);
  });

  test("rejects entries without a port, with an empty name, or a non-positive port", () => {
    expect(() => parseServicesList("noport")).toThrow(/expected format/);
    expect(() => parseServicesList(":3000")).toThrow(/container name is empty/);
    expect(() => parseServicesList("api:abc")).toThrow(/not a valid number/);
    expect(() => parseServicesList("api:0")).toThrow(/not a valid number/);
    expect(() => parseServicesList("api:-5")).toThrow(/not a valid number/);
  });

  test("invalid entries carry exit code 2", () => {
    try {
      parseServicesList("noport");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });
});

describe("buildDeployments", () => {
  const discovered: DiscoveredService[] = [
    { container_name: "api", container_port: 3000, image_tag: "acme/api:1" },
    { container_name: "web", container_port: 8080, image_tag: null },
    { container_name: "orphan", container_port: 9090, image_tag: null },
  ];

  test("drops unmatched containers, applies force, and only sets image_tag when known", () => {
    const out = buildDeployments(discovered, ["orphan"], true);
    expect(out).toEqual([
      { container_name: "api", container_port: 3000, force: true, image_tag: "acme/api:1" },
      { container_name: "web", container_port: 8080, force: true },
    ]);
  });

  test("force=false is still set explicitly", () => {
    const out = buildDeployments([discovered[0] as DiscoveredService], [], false);
    expect(out[0]?.force).toBe(false);
  });

  test("carries application_ref and keeps a service matched by ref even when its name is unmatched", () => {
    const withRef: DiscoveredService[] = [
      { container_name: "app", container_port: 3000, image_tag: null, application_ref: "quidax-gw" },
    ];
    // API reports container_name "app" unmatched, but the ref matched → keep it.
    const out = buildDeployments(withRef, ["app"], false);
    expect(out).toEqual([
      { container_name: "app", container_port: 3000, force: false, application_ref: "quidax-gw" },
    ]);
  });

  test("drops a service only when both its name and ref are unmatched", () => {
    const withRef: DiscoveredService[] = [
      { container_name: "app", container_port: 3000, image_tag: null, application_ref: "quidax-gw" },
    ];
    expect(buildDeployments(withRef, ["app", "quidax-gw"], false)).toEqual([]);
  });
});

describe("discoverFromCompose — application_ref labels", () => {
  test("extracts reoclo.app as application_ref (array label form)", async () => {
    const out = await discoverFromCompose(
      compose(`
services:
  app:
    networks: [reoclo-proxy]
    expose: ["3000"]
    labels: ["reoclo.app=quidax-gateway"]
`),
    );
    expect(out).toEqual([
      {
        container_name: "app",
        container_port: 3000,
        image_tag: null,
        application_ref: "quidax-gateway",
      },
    ]);
  });

  test("reoclo.app-id wins over reoclo.app (map label form)", async () => {
    const out = await discoverFromCompose(
      compose(`
services:
  app:
    networks:
      reoclo-proxy: {}
    expose: ["3000"]
    labels:
      reoclo.app: by-slug
      reoclo.app-id: 019eaa29-d367-7350-9f68-fb676bee1380
`),
    );
    expect(out).toEqual([
      {
        container_name: "app",
        container_port: 3000,
        image_tag: null,
        application_ref: "019eaa29-d367-7350-9f68-fb676bee1380",
      },
    ]);
  });
});

describe("summarizeSync", () => {
  function item(p: Partial<DeploySyncResponseItem>): DeploySyncResponseItem {
    return {
      application_id: "a",
      container_name: "c",
      status: "synced",
      signature_hash: "h",
      synced_fqdns: [],
      reason: null,
      ...p,
    };
  }
  function resp(results: DeploySyncResponseItem[], errors: DeploySyncResponse["errors"] = []): DeploySyncResponse {
    return { session_id: "s", results, errors };
  }

  test("de-dupes synced + drift_recovered fqdns and ignores conflict/noop fqdns", () => {
    const s = summarizeSync(
      resp([
        item({ status: "synced", synced_fqdns: ["a.com", "b.com"] }),
        item({ status: "drift_recovered", synced_fqdns: ["b.com", "c.com"] }),
        item({ status: "noop", synced_fqdns: ["d.com"] }),
        item({ status: "conflict", synced_fqdns: ["e.com"], reason: "held" }),
      ]),
      false,
    );
    expect(s.syncedFqdns.sort()).toEqual(["a.com", "b.com", "c.com"]);
  });

  test("unforced conflict → exitOk false; forced conflict → exitOk true", () => {
    const withConflict = resp([item({ status: "conflict", reason: "held" })]);
    expect(summarizeSync(withConflict, false).exitOk).toBe(false);
    expect(summarizeSync(withConflict, false).conflicts).toEqual(["c: held"]);
    expect(summarizeSync(withConflict, true).exitOk).toBe(true);
  });

  test("errors → exitOk false even with --force", () => {
    const s = summarizeSync(resp([item({})], [{ container_name: "x", reason: "boom" }]), true);
    expect(s.exitOk).toBe(false);
    expect(s.errors).toEqual([{ container_name: "x", reason: "boom" }]);
  });

  test("clean run → exitOk true", () => {
    expect(summarizeSync(resp([item({ status: "synced" })]), false).exitOk).toBe(true);
  });
});
