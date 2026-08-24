// src/client/enums.ts
//
// Single source of truth for static enum tuples used by CLI command flags.
// Exports both the `as const` tuple (for withCompletion configs) and a zod
// `z.enum(...)` schema (for runtime action validation + typed narrowing).

import { z } from "zod";

export const SOURCE_TYPES = [
  "container",
  "system",
  "docker_daemon",
  "runner",
  "kernel",
  "auth",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SourceTypeSchema = z.enum(SOURCE_TYPES);

export const STREAMS = ["stdout", "stderr", "journal"] as const;
export type Stream = (typeof STREAMS)[number];
export const StreamSchema = z.enum(STREAMS);

export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LogLevelSchema = z.enum(LOG_LEVELS);

export const REGISTRY_TYPES = ["docker", "ecr", "private"] as const;
export type RegistryType = (typeof REGISTRY_TYPES)[number];
export const RegistryTypeSchema = z.enum(REGISTRY_TYPES);

/** What a status component watches. Every kind except "manual" needs a ref id. */
export const COMPONENT_SOURCE_KINDS = [
  "domain",
  "server",
  "application",
  "monitor",
  "manual",
] as const;
export type ComponentSourceKind = (typeof COMPONENT_SOURCE_KINDS)[number];
export const ComponentSourceKindSchema = z.enum(COMPONENT_SOURCE_KINDS);

export const COMPONENT_STATUSES = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];
export const ComponentStatusSchema = z.enum(COMPONENT_STATUSES);

// Shared positive-integer schema for `limit` params in MCP tools. The CLI
// equivalent is `parseLimit` in src/util/parse-limit.ts.
export const LimitSchema = z.number().int().positive();
