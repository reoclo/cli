// tests/integration/completion.test.ts
import { expect, test } from "bun:test";
import { $ } from "bun";

test("__complete with no args emits top-level commands", async () => {
  const r = await $`bun run src/index.ts __complete -- ""`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("apps");
  expect(out).toContain("servers");
  expect(out).toContain("login");
  expect(out).not.toContain("__complete");
});

test("__complete apps emits apps subcommands", async () => {
  const r = await $`bun run src/index.ts __complete apps -- ""`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("ls");
  expect(out).toContain("get");
  expect(out).toContain("deploy");
  expect(out).toContain("restart");
});

test("__complete with --as current emits flags", async () => {
  const r = await $`bun run src/index.ts __complete apps deploy -- --`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("--ref");
  expect(out).toContain("--wait");
});

test("completion bash emits a thin shim that defers to __complete", async () => {
  const r = await $`bun run src/index.ts completion bash`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("reoclo __complete");
  expect(out).toContain("complete -F _reoclo reoclo");
});

test("completion zsh emits a thin shim with #compdef header", async () => {
  const r = await $`bun run src/index.ts completion zsh`.quiet();
  const out = r.stdout.toString();
  expect(out.startsWith("#compdef reoclo")).toBe(true);
  expect(out).toContain("reoclo __complete");
});

test("completion fish emits a thin shim that calls __complete", async () => {
  const r = await $`bun run src/index.ts completion fish`.quiet();
  const out = r.stdout.toString();
  expect(out).toContain("reoclo __complete");
  expect(out).toContain("complete -c reoclo");
});
