#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { registerProfile } from "./commands/profile";
import { registerKeyring } from "./commands/keyring";

export const VERSION = pkg.version;

if (import.meta.main) {
  const program = new Command()
    .name("reoclo")
    .description("Reoclo CLI")
    .version(VERSION);
  registerProfile(program);
  registerKeyring(program);
  await program.parseAsync(process.argv);
}
