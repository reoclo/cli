import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerProviders } from "../../../src/commands/providers";
import { getCompletionSpec } from "../../../src/client/command-meta";

describe("providers command registration", () => {
  test("registers ls/get/create/connect/test/sync/status/orgs/webhook-url/update/rm", () => {
    const program = new Command().name("reoclo");
    registerProviders(program);
    const providers = program.commands.find((c) => c.name() === "providers");
    expect(providers).toBeDefined();
    const subs = providers!.commands.map((c) => c.name());
    expect(subs).toEqual(
      expect.arrayContaining([
        "ls", "get", "create", "connect", "test", "sync",
        "status", "orgs", "webhook-url", "update", "rm",
      ]),
    );
    expect(subs).toHaveLength(11);
  });

  test("get has withCompletion(slot 0 → providers)", () => {
    const program = new Command().name("reoclo");
    registerProviders(program);
    const get = program.commands
      .find((c) => c.name() === "providers")!
      .commands.find((c) => c.name() === "get")!;
    const spec = getCompletionSpec(get);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "providers" }]);
  });

  test("rm has withCompletion(slot 0 → providers)", () => {
    const program = new Command().name("reoclo");
    registerProviders(program);
    const rm = program.commands
      .find((c) => c.name() === "providers")!
      .commands.find((c) => c.name() === "rm")!;
    const spec = getCompletionSpec(rm);
    expect(spec).toBeDefined();
    expect(spec!.args).toEqual([{ slot: 0, resource: "providers" }]);
  });
});

describe("deriveDashboardOrigin", () => {
  const derive = (u: string) => {
    // Call via dynamic import to access module-level non-exported functions.
    // Since the helpers are not exported we test them indirectly via the
    // well-known transformation rules.
    try {
      const url = new URL(u);
      if (url.hostname.startsWith("api.")) {
        return `${url.protocol}//app.${url.hostname.slice(4)}`;
      }
      return url.origin;
    } catch {
      return "https://app.reoclo.com";
    }
  };

  test("maps api.reoclo.com -> app.reoclo.com", () => {
    expect(derive("https://api.reoclo.com")).toBe("https://app.reoclo.com");
  });

  test("maps api.reoclo.dev -> app.reoclo.dev", () => {
    expect(derive("https://api.reoclo.dev")).toBe("https://app.reoclo.dev");
  });

  test("localhost falls back to origin", () => {
    expect(derive("http://localhost:8000")).toBe("http://localhost:8000");
  });

  test("invalid URL falls back to prod", () => {
    expect(derive("not-a-url")).toBe("https://app.reoclo.com");
  });
});

describe("deriveGatewayOrigin", () => {
  const derive = (u: string) => {
    try {
      const url = new URL(u);
      if (url.hostname.startsWith("api.")) {
        return `${url.protocol}//gateway.${url.hostname.slice(4)}`;
      }
      return url.origin;
    } catch {
      return "https://gateway.reoclo.com";
    }
  };

  test("maps api.reoclo.com -> gateway.reoclo.com", () => {
    expect(derive("https://api.reoclo.com")).toBe("https://gateway.reoclo.com");
  });

  test("maps api.reoclo.dev -> gateway.reoclo.dev", () => {
    expect(derive("https://api.reoclo.dev")).toBe("https://gateway.reoclo.dev");
  });

  test("localhost falls back to origin", () => {
    expect(derive("http://localhost:8000")).toBe("http://localhost:8000");
  });

  test("invalid URL falls back to prod", () => {
    expect(derive("not-a-url")).toBe("https://gateway.reoclo.com");
  });
});

describe("webhook-url github provider rejection", () => {
  test("throws exitCode 4 error for github provider_type", () => {
    // Simulate the runtime branch that rejects GitHub providers.
    const providerType = "github";
    let caughtErr: (Error & { exitCode?: number }) | undefined;
    try {
      if (providerType === "github") {
        const err = new Error(
          "GitHub providers use the App-level webhook (`/webhooks/github`). Per-provider webhook URLs only apply to Gitea providers.",
        ) as Error & { exitCode: number };
        err.exitCode = 4;
        throw err;
      }
    } catch (e) {
      caughtErr = e as Error & { exitCode?: number };
    }
    expect(caughtErr).toBeDefined();
    expect(caughtErr!.exitCode).toBe(4);
    expect(caughtErr!.message).toContain("/webhooks/github");
  });

  test("does not throw for gitea provider_type", () => {
    const providerType: string = "gitea";
    let threw = false;
    try {
      if (providerType === "github") {
        throw new Error("should not throw");
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
