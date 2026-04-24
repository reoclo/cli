#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };

export const VERSION = pkg.version;

if (import.meta.main) {
  const program = new Command()
    .name("reoclo")
    .description("Reoclo CLI")
    .version(VERSION);
  await program.parseAsync(process.argv);
}
