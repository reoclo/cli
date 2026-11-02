// The reoclo skills served as guides, through a real MCP client and the CLI's
// own server (createMcpServer), connected in memory. Tool registration never
// calls the API, so the client stub is never used.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type HttpClient } from "../../../src/mcp/server";
import { GUIDE_INSTRUCTIONS, guideSections } from "../../../src/mcp/tools/guides";
import { GUIDES } from "../../../src/mcp/tools/guides-content";

let client: Client;

beforeEach(async () => {
  const server = createMcpServer({
    client: {} as HttpClient,
    orgParam: {},
    resolveOrg: () => Promise.reject(new Error("guides never resolve an org")),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "guides-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await client.close();
});

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join("");
}

test("the bundled guides include both reoclo skills", () => {
  expect(GUIDES.map((g) => g.name)).toEqual(["reoclo-cli-usage", "reoclo-github-actions"]);
  for (const g of GUIDES) expect(g.body.startsWith("---")).toBe(false);
});

test("the server sends its instructions at initialize", () => {
  expect(client.getInstructions()).toBe(GUIDE_INSTRUCTIONS);
});

test("list_guides names every guide with its section titles", async () => {
  const listed = JSON.parse(text(await client.callTool({ name: "list_guides", arguments: {} }))) as Array<{
    name: string;
    sections: string[];
  }>;
  expect(listed.map((g) => g.name)).toEqual(GUIDES.map((g) => g.name));
  const cli = listed.find((g) => g.name === "reoclo-cli-usage");
  expect(cli?.sections).toContain("First run");
  expect(cli?.sections).toContain("MCP server");
});

test("get_guide returns a whole guide, or one section matched without case", async () => {
  const cli = GUIDES.find((g) => g.name === "reoclo-cli-usage");
  const whole = await client.callTool({ name: "get_guide", arguments: { name: "reoclo-cli-usage" } });
  expect(text(whole)).toBe(cli?.body ?? "");

  const section = text(
    await client.callTool({ name: "get_guide", arguments: { name: "reoclo-cli-usage", section: "first RUN" } }),
  );
  expect(section.startsWith("## First run\n")).toBe(true);
  expect(section).not.toContain("\n## ");
});

test("get_guide names the choices when the guide or section is unknown", async () => {
  const noGuide = await client.callTool({ name: "get_guide", arguments: { name: "nope" } });
  expect(noGuide.isError).toBe(true);
  expect(text(noGuide)).toContain("reoclo-cli-usage");

  const noSection = await client.callTool({
    name: "get_guide",
    arguments: { name: "reoclo-cli-usage", section: "nope" },
  });
  expect(noSection.isError).toBe(true);
  expect(text(noSection)).toContain("First run");
});

test("each guide is also a prompt carrying its body", async () => {
  const { prompts } = await client.listPrompts();
  expect(prompts.map((p) => p.name).sort()).toEqual(GUIDES.map((g) => g.name).sort());
  const prompt = await client.getPrompt({ name: "reoclo-github-actions" });
  const message = prompt.messages[0]?.content as { type: string; text: string };
  expect(message.text).toBe(GUIDES.find((g) => g.name === "reoclo-github-actions")?.body ?? "");
});

test("guideSections ignores headings inside code fences", () => {
  const body = "intro\n## One\n```md\n## not a heading\n```\n## Two\nend\n";
  expect(guideSections(body).map((s) => s.title)).toEqual(["One", "Two"]);
});
