import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore } from "../../../src/config/keyring/file";
import { saveProfile } from "../../../src/config/store";
import { withConfigDir } from "../../../src/config/paths";

test("FileStore persists token into config.json under profile", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "fs-"));
  await withConfigDir(tmp, async () => {
    await saveProfile("default", {
      api_url: "x",
      token_type: "tenant",
      tenant_id: "t",
      tenant_slug: "s",
      user_email: "e",
      saved_at: "now",
    });
    const fs = new FileStore();
    await fs.set("default", "rk_t_abc");
    expect(await fs.get("default")).toBe("rk_t_abc");
    await fs.delete("default");
    expect(await fs.get("default")).toBeNull();
  });
});
