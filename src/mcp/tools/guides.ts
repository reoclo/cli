// src/mcp/tools/guides.ts
//
// The reoclo skills, served as guides so an agent asks the MCP server how to
// drive Reoclo instead of relying on copies installed into each repository.
// The text is bundled from github.com/reoclo/skills by scripts/sync-skills.ts
// (./guides-content). The hosted MCP vendors this module, so both servers
// serve the same guides and the same instructions.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { asToolResult } from "./common";
import { GUIDES } from "./guides-content";

/** Server instructions, sent to the client at initialize. */
export const GUIDE_INSTRUCTIONS = [
  "Reoclo deploys and runs applications on servers the user brings.",
  "Before a first Reoclo task, call list_guides and read the matching guide with get_guide, passing section to read one part:",
  "reoclo-cli-usage covers the platform through the CLI and these tools, and reoclo-github-actions covers CI.",
  "Sessions refresh on their own. Only when a tool fails on authentication, ask the user to sign in again",
  "(`reoclo login` for the local server); never sign in pre-emptively.",
].join(" ");

export interface GuideSection {
  title: string;
  text: string;
}

/** Split a guide at its `## ` headings, ignoring lines inside code fences. */
export function guideSections(body: string): GuideSection[] {
  const sections: GuideSection[] = [];
  let current: GuideSection | undefined;
  let fenced = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), text: "" };
      sections.push(current);
    }
    if (current) current.text += `${line}\n`;
  }
  return sections;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { ...textResult(text), isError: true };
}

export function registerGuideTools(server: McpServer): void {
  server.tool(
    "list_guides",
    "List the Reoclo guides (using the reoclo CLI and this server's tools, and Reoclo in CI) with their section titles. Read one with get_guide.",
    {},
    () =>
      asToolResult(
        GUIDES.map((g) => ({
          name: g.name,
          description: g.description,
          sections: guideSections(g.body).map((s) => s.title),
        })),
      ),
  );

  server.tool(
    "get_guide",
    "Read a Reoclo guide, or one section of it. Guide names and section titles come from list_guides.",
    {
      name: z.string().min(1).describe("Guide name from list_guides, for example reoclo-cli-usage"),
      section: z
        .string()
        .min(1)
        .optional()
        .describe("Section title from list_guides (case-insensitive). Omit to read the whole guide."),
    },
    ({ name, section }) => {
      const guide = GUIDES.find((g) => g.name === name);
      if (!guide) {
        return errorResult(`no guide '${name}'. Guides: ${GUIDES.map((g) => g.name).join(", ")}`);
      }
      if (!section) return textResult(guide.body);
      const sections = guideSections(guide.body);
      const wanted = section.trim().toLowerCase();
      const match = sections.find((s) => s.title.toLowerCase() === wanted);
      if (!match) {
        return errorResult(
          `no section '${section}' in ${name}. Sections: ${sections.map((s) => s.title).join("; ")}`,
        );
      }
      return textResult(match.text);
    },
  );

  for (const guide of GUIDES) {
    server.prompt(guide.name, guide.description, () => ({
      messages: [{ role: "user", content: { type: "text", text: guide.body } }],
    }));
  }
}
