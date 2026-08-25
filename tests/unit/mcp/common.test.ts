import { expect, test } from "bun:test";
import { z } from "zod";
import { optionalOrgParam } from "../../../src/mcp/tools/common";
import type { McpRegistrationContext } from "../../../src/mcp/tools/context";

function ctxWith(orgParam: McpRegistrationContext["orgParam"]): McpRegistrationContext {
  return {
    client: {} as McpRegistrationContext["client"],
    orgParam,
    resolveOrg: async () => ({ tenantId: "t", client: {} as McpRegistrationContext["client"] }),
  };
}

test("optionalOrgParam keeps an empty shape empty (CLI host)", () => {
  expect(optionalOrgParam(ctxWith({}))).toEqual({});
});

test("optionalOrgParam makes every entry optional (hosted host)", () => {
  const shape = optionalOrgParam(ctxWith({ organization: z.string().min(1) }));
  expect(Object.keys(shape)).toEqual(["organization"]);
  expect(shape.organization!.safeParse(undefined).success).toBe(true);
  expect(shape.organization!.safeParse("acme").success).toBe(true);
  expect(shape.organization!.safeParse("").success).toBe(false);
});
