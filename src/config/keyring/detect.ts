import { which } from "bun";

export interface KeyringCapability {
  platform: "darwin" | "linux" | "win32";
  binary: string;
}

export function detectKeyringBinary(plat: string = process.platform): Promise<KeyringCapability | null> {
  if (plat === "darwin")  return Promise.resolve(which("security")    ? { platform: "darwin", binary: "security" } : null);
  if (plat === "linux")   return Promise.resolve(which("secret-tool") ? { platform: "linux",  binary: "secret-tool" } : null);
  if (plat === "win32")   return Promise.resolve(which("cmdkey")      ? { platform: "win32",  binary: "cmdkey" } : null);
  return Promise.resolve(null);
}
