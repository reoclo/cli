// src/mcp/tools/context.ts
//
// The tool catalog never knows which organization it acts on. Every
// tenant-scoped tool spreads `orgParam` into its input schema and asks
// `resolveOrg` for the tenant id and the client to use on each call. The
// host decides what that means: the hosted head requires an `organization`
// argument and exchanges the caller's token for one bound to it; the CLI
// exposes no argument and answers with the org `bootstrap()` already bound
// (`--org` / $REOCLO_ORG / `.reoclo`). There is no tenantId on this
// interface on purpose: nothing can close over a tenant at registration.
import type { z } from "zod";
import type { HttpClient } from "../../client/http";

// A plain `Record<string, z.ZodType>` here reads as more generic than the
// interface actually needs, but TypeScript cannot preserve an index
// signature through an object spread: `{ ...ctx.orgParam, field: ... }`
// would infer a schema type that silently drops `organization`, and every
// call to `ctx.resolveOrg(args.organization)` downstream would fail to
// typecheck. Every host that populates `orgParam` uses exactly this one
// named, optional key, so the literal shape below is both accurate and
// spreadable.
export type OrgParamShape = { organization?: z.ZodType };

export interface OrgScope {
  tenantId: string;
  client: HttpClient;
}

export interface McpRegistrationContext {
  /** Client for tenant-agnostic calls (whoami without an organization). */
  client: HttpClient;
  /** Zod fragment each tenant-scoped tool spreads into its input schema. */
  orgParam: OrgParamShape;
  /** Resolve the organization a call acts on. Hosts throw an Error with a
   *  model-readable message when the argument is missing or unknown. */
  resolveOrg(organization?: unknown): Promise<OrgScope>;
}
