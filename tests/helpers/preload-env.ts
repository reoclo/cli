// Test preload — runs before any test module is imported (registered in
// bunfig.toml `[test] preload`).
//
// Strips inherited REOCLO_* environment so the suite always runs against a
// clean, prod-default configuration regardless of the developer's shell. A
// configured `reoclo` CLI commonly exports REOCLO_API_URL / REOCLO_PROFILE
// (e.g. pointed at staging); without this, those values leak into the test
// process and break assertions that expect prod defaults.
//
// Why a preload and not a beforeEach: `src/lib/urls.ts` and
// `src/client/bootstrap.ts` capture env-derived values into module-level
// constants AT IMPORT TIME (e.g. `ROOT_DOMAIN`, `PROD_API_URL`,
// `PROD_STREAMS_URL`). A per-test `delete process.env.REOCLO_*` runs after
// those modules have already loaded, so it cannot undo the baked-in value.
// The preload runs before any module loads, so the constants are computed
// from a clean environment.
//
// Tests that need specific configuration set it explicitly (a temp
// REOCLO_CONFIG_DIR with a seeded profile, the in-process fake gateway, etc.),
// so clearing the inherited values here is safe — including for the
// integration suite, which never relies on an inherited REOCLO_* var.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("REOCLO_")) {
    delete process.env[key];
  }
}
