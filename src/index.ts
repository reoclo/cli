#!/usr/bin/env bun
import { Command } from "commander";

const VERSION = "0.0.1";

const program = new Command()
  .name("reoclo")
  .description("Reoclo CLI")
  .version(VERSION);

void program.parseAsync(process.argv);
