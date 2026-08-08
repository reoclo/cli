import { test, expect } from "bun:test";
import { resolveGatingCapabilities } from "../../../src/client/gating";

test("resolveGatingCapabilities returns undefined under an env credential", () => {
  expect(
    resolveGatingCapabilities({ isEnvCredential: true, profileCapabilities: ["container:read"] }),
  ).toBeUndefined();
});

test("resolveGatingCapabilities returns the profile caps for a normal profile", () => {
  expect(
    resolveGatingCapabilities({ isEnvCredential: false, profileCapabilities: ["container:read"] }),
  ).toEqual(["container:read"]);
});

test("resolveGatingCapabilities passes undefined profile caps through", () => {
  expect(
    resolveGatingCapabilities({ isEnvCredential: false, profileCapabilities: undefined }),
  ).toBeUndefined();
});
