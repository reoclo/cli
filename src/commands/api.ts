// src/commands/api.ts
//
// Raw authenticated API passthrough (`reoclo api`), in the spirit of `gh api`.
// Escape hatch for surfaces the CLI has no dedicated command for yet: the
// request rides the same profile auth, base URL, and token-derived prefix as
// every other command, so `/tenants/{tenant}/...` paths work as-is without
// keychain archaeology or hand-built curl invocations.

import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { globalOutput, resolveFormat } from "../ui/output";

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export interface ApiRequestInput {
  path: string;
  method?: string;
  /** `-f key=value` pairs; values are auto-typed (true/false/null/number). */
  fields?: string[];
  /** `--raw-field key=value` pairs; values stay strings. */
  rawFields?: string[];
  /** Raw JSON body; mutually exclusive with fields/rawFields. */
  data?: string;
  /** `-q key=value` pairs appended to the query string. */
  query?: string[];
  /** Replaces `{tenant}` in the path. */
  tenantId?: string;
}

export interface ApiRequest {
  method: ApiMethod;
  path: string;
  body: unknown;
}

function fail(message: string): never {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

function splitPair(pair: string, flag: string): [string, string] {
  const idx = pair.indexOf("=");
  if (idx <= 0) fail(`${flag} expects key=value, got '${pair}'`);
  return [pair.slice(0, idx), pair.slice(idx + 1)];
}

/** `-f` value auto-typing: JSON literals and numbers keep their type. */
export function typedFieldValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/**
 * Pure request assembly: placeholder expansion, query merging, body building,
 * and method defaulting. Kept free of IO so tests exercise every branch.
 */
export function buildApiRequest(input: ApiRequestInput): ApiRequest {
  let path = input.path.startsWith("/") ? input.path : `/${input.path}`;

  if (path.includes("{tenant}")) {
    if (!input.tenantId) fail("path uses {tenant} but no organization is selected");
    path = path.replaceAll("{tenant}", input.tenantId);
  }

  for (const pair of input.query ?? []) {
    const [key, value] = splitPair(pair, "--query");
    const sep = path.includes("?") ? "&" : "?";
    path += `${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }

  const hasFields = (input.fields?.length ?? 0) + (input.rawFields?.length ?? 0) > 0;
  if (input.data !== undefined && hasFields) {
    fail("--data cannot be combined with --field/--raw-field");
  }

  let body: unknown;
  if (input.data !== undefined) {
    try {
      body = JSON.parse(input.data);
    } catch {
      fail("--data is not valid JSON");
    }
  } else if (hasFields) {
    const obj: Record<string, unknown> = {};
    for (const pair of input.fields ?? []) {
      const [key, value] = splitPair(pair, "--field");
      obj[key] = typedFieldValue(value);
    }
    for (const pair of input.rawFields ?? []) {
      const [key, value] = splitPair(pair, "--raw-field");
      obj[key] = value;
    }
    body = obj;
  }

  const method = (input.method ?? (body !== undefined ? "POST" : "GET")).toUpperCase();
  if (!API_METHODS.includes(method as ApiMethod)) {
    fail(`unsupported method '${input.method}' (use ${API_METHODS.join(", ")})`);
  }
  if (body !== undefined && (method === "GET" || method === "DELETE")) {
    fail(`${method} requests cannot carry a body`);
  }

  return { method: method as ApiMethod, path, body };
}

async function readData(data: string | undefined): Promise<string | undefined> {
  if (data === undefined) return undefined;
  if (data === "-") return await Bun.stdin.text();
  if (data.startsWith("@")) return await Bun.file(data.slice(1)).text();
  return data;
}

export function registerApi(program: Command): void {
  program
    .command("api <path>")
    .description(
      "raw authenticated API request ({tenant} in the path expands to the current organization's tenant id)",
    )
    .option("-X, --method <verb>", "HTTP method (default GET, or POST when a body is given)")
    .option(
      "-f, --field <key=value>",
      "JSON body field; true/false/null/numbers keep their type (repeatable)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option(
      "--raw-field <key=value>",
      "JSON body field, value kept as a string (repeatable)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("--data <json>", "raw JSON body ('@file' reads a file, '-' reads stdin)")
    .option(
      "-q, --query <key=value>",
      "append a query-string parameter (repeatable)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .action(
      async (
        path: string,
        opts: {
          method?: string;
          field: string[];
          rawField: string[];
          data?: string;
          query: string[];
        },
      ) => {
        // Format flag is accepted for consistency; both text and json print
        // the response body as JSON (it IS the output of this command).
        resolveFormat(globalOutput(program));
        const ctx = await bootstrap();
        const tenantId = path.includes("{tenant}") ? await requireTenantId(ctx) : undefined;

        const req = buildApiRequest({
          path,
          method: opts.method,
          fields: opts.field,
          rawFields: opts.rawField,
          data: await readData(opts.data),
          query: opts.query,
          tenantId,
        });

        const c = ctx.client;
        let result: unknown;
        switch (req.method) {
          case "GET":
            result = await c.get<unknown>(req.path);
            break;
          case "POST":
            result = await c.post<unknown>(req.path, req.body);
            break;
          case "PUT":
            result = await c.put<unknown>(req.path, req.body);
            break;
          case "PATCH":
            result = await c.patch<unknown>(req.path, req.body);
            break;
          case "DELETE":
            result = await c.del<unknown>(req.path);
            break;
        }
        if (result !== undefined && result !== null && result !== "") {
          console.log(JSON.stringify(result, null, 2));
        }
      },
    );
}
