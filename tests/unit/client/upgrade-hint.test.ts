import { describe, expect, test } from "bun:test";
import { upgradeCommandFor } from "../../../src/client/upgrade-hint";

describe("upgradeCommandFor", () => {
  test("homebrew uses the tap (version-independent)", () => {
    expect(upgradeCommandFor("homebrew", "0.49.0")).toBe("brew upgrade reoclo/tap/reoclo");
  });

  test("npm pins the version", () => {
    expect(upgradeCommandFor("npm", "0.49.0")).toBe("npm i -g @reoclo/cli@0.49.0");
  });

  test("pnpm pins the version", () => {
    expect(upgradeCommandFor("pnpm", "0.49.0")).toBe("pnpm add -g @reoclo/cli@0.49.0");
  });

  test("yarn pins the version", () => {
    expect(upgradeCommandFor("yarn", "0.49.0")).toBe("yarn global add @reoclo/cli@0.49.0");
  });

  test("mise pins the version", () => {
    expect(upgradeCommandFor("mise", "0.49.0")).toBe("mise use -g reoclo@0.49.0");
  });

  test("asdf installs then sets global", () => {
    expect(upgradeCommandFor("asdf", "0.49.0")).toBe(
      "asdf install reoclo 0.49.0 && asdf global reoclo 0.49.0",
    );
  });

  test("raw installs self-upgrade via the CLI", () => {
    expect(upgradeCommandFor("raw", "0.49.0")).toBe("reoclo upgrade");
  });
});
