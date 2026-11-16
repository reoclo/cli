import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerStorageCredentials, storageCredentialPatch } from "../../../src/commands/storage-credentials";
import { applyVerbAliases } from "../../../src/lib/verb-aliases";

function program(): Command {
  const root = new Command().name("reoclo");
  registerStorageCredentials(root);
  return root;
}

const group = (root: Command): Command => root.commands.find((c) => c.name() === "storage-credentials")!;
const leaf = (root: Command, name: string): Command => group(root).commands.find((c) => c.name() === name)!;
const longs = (cmd: Command): string[] => cmd.options.map((o) => o.long ?? "");

async function failure(args: string[]): Promise<{ exitCode?: number; message: string }> {
  return (await program().parseAsync(["node", "reoclo", "storage-credentials", ...args]).catch((e: unknown) => e)) as { exitCode?: number; message: string };
}

describe("storage-credentials surface", () => {
  test("registers ls, get, create, edit and rm", () => {
    expect(group(program()).commands.map((c) => c.name()).sort()).toEqual(["create", "edit", "get", "ls", "rm"]);
  });

  test("create takes the key id, endpoint, description and a stdin secret, never the secret itself", () => {
    const secretFlags = ["--endpoint", "--description", "--secret-key-stdin"];
    for (const flag of ["--name", "--access-key-id", ...secretFlags]) expect(longs(leaf(program(), "create"))).toContain(flag);
    expect(longs(leaf(program(), "create"))).not.toContain("--secret-key");
    for (const flag of ["--name", "--access-key-id", ...secretFlags]) expect(longs(leaf(program(), "edit"))).toContain(flag);
    expect(longs(leaf(program(), "rm"))).toContain("--yes");
    for (const flag of ["--skip", "--limit"]) expect(longs(leaf(program(), "ls"))).toContain(flag);
  });

  test("the collection verbs answer to their other spellings", () => {
    const root = program();
    applyVerbAliases(root);
    expect(leaf(root, "ls").aliases()).toContain("list");
    expect(leaf(root, "rm").aliases()).toEqual(["delete", "remove"]);
  });
});

describe("storageCredentialPatch", () => {
  test("sends only the fields given, mapped to the API names", () => {
    expect(storageCredentialPatch({ name: "r2", description: "main" }, undefined)).toEqual({ name: "r2", description: "main" });
    expect(storageCredentialPatch({ endpoint: "https://x.r2", accessKeyId: "AK" }, "s3cret")).toEqual({
      endpoint: "https://x.r2",
      access_key_id: "AK",
      secret_key: "s3cret",
    });
  });

  test("is null when nothing changes", () => {
    expect(storageCredentialPatch({}, undefined)).toBeNull();
  });
});

describe("usage errors exit 2 before any request", () => {
  test("a new endpoint or key id without the new secret", async () => {
    const endpoint = await failure(["edit", "r2", "--endpoint", "https://x.example"]);
    expect(endpoint.exitCode).toBe(2);
    expect(endpoint.message).toContain("--secret-key-stdin");
    expect((await failure(["edit", "r2", "--access-key-id", "AK"])).exitCode).toBe(2);
  });

  test("an edit that changes nothing", async () => {
    const result = await failure(["edit", "r2"]);
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("no fields to update");
  });
});
