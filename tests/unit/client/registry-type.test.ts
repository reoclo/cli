import { describe, expect, it } from "bun:test";

import { REGISTRY_TYPES, parseRegistryType } from "../../../src/client/enums";

describe("parseRegistryType", () => {
  it("accepts every API registry type unchanged", () => {
    for (const type of REGISTRY_TYPES) expect(parseRegistryType(type)).toBe(type);
  });

  it("maps the older short names to the API names", () => {
    expect(parseRegistryType("docker")).toBe("docker_hub");
    expect(parseRegistryType("ecr")).toBe("aws_ecr");
    expect(parseRegistryType("private")).toBe("generic");
  });

  it("rejects an unknown type", () => {
    expect(() => parseRegistryType("quay")).toThrow();
  });
});
