// src/commands/relocate.ts
import type { Command } from "commander";
import { bootstrap, requireTenantId } from "../client/bootstrap";
import { resolveApp, resolveServer } from "../client/resolve";
import {
  act,
  getEvents,
  getRelocation,
  listRelocations,
  needsOperator,
  planRelocation,
  resolveGroupId,
  type Relocation,
  type RequestedItem,
  type VolumeChoice,
} from "../client/relocate";
import type { HttpClient } from "../client/http";
import { confirmPrompt } from "../ui/interactive";
import { globalOutput, printList, printMutation, printObject, resolveFormat } from "../ui/output";

const WATCH_INTERVAL_MS = 3000;
const collect = (value: string, prev: string[]) => [...prev, value];

function fail(message: string, exitCode: number): never {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = exitCode;
  throw e;
}

async function confirmed(yes: boolean | undefined, question: string): Promise<void> {
  if (yes) return;
  if (!(await confirmPrompt(question, { initialValue: false, fallback: false }))) {
    fail("aborted (pass --yes to confirm non-interactively)", 2);
  }
}

function summary(run: Relocation): Record<string, unknown> {
  return {
    id: run.id,
    state: run.state,
    plan_hash: run.plan_hash ?? "",
    waiting: run.pause_reason ?? "",
    error: run.error_code ?? "",
    actions: run.permitted_actions.join(","),
  };
}

async function warmChoices(c: HttpClient, tid: string, refs: string[]): Promise<VolumeChoice[]> {
  const choices: VolumeChoice[] = [];
  for (const ref of refs) {
    const at = ref.lastIndexOf(":");
    if (at <= 0 || at === ref.length - 1) fail(`--warm expects <server>:<volume>, got '${ref}'`, 2);
    choices.push({
      source_server_id: await resolveServer(c, tid, ref.slice(0, at)),
      volume_name: ref.slice(at + 1),
      mode: "warm_files",
      ordinary_files_acknowledged: true,
    });
  }
  return choices;
}

export function registerRelocate(program: Command): void {
  const g = program
    .command("relocate")
    .description("move services and their data to another server (planned, then explicitly started)");

  g.command("plan")
    .description("check a relocation plan; never starts it")
    .option("--app <ref>", "application id, slug or name (repeatable)", collect, [])
    .option("--stack <ref>", "compose stack id, slug or name (repeatable)", collect, [])
    .option("--group <ref>", "application group id, slug or name (repeatable)", collect, [])
    .requiredOption("--to <server>", "target server id, slug or name")
    .option("--gate-before-cutover", "wait for an explicit `run --cutover` before traffic moves")
    .option("--warm <server:volume>", "copy this volume warm (ordinary files only; repeatable)", collect, [])
    .option("--ordinary-files-ok", "confirm --warm volumes hold only ordinary files")
    .option("--no-auto-commit", "keep the source after the 72-hour window until `relocate commit`")
    .action(
      async (opts: {
        app: string[]; stack: string[]; group: string[]; to: string; gateBeforeCutover?: boolean;
        warm: string[]; ordinaryFilesOk?: boolean; autoCommit: boolean;
      }) => {
        if (opts.app.length + opts.stack.length + opts.group.length === 0) {
          fail("pass at least one --app, --stack or --group", 2);
        }
        if (opts.warm.length > 0 && !opts.ordinaryFilesOk) {
          fail("--warm needs --ordinary-files-ok; cold copy is the default", 2);
        }
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const items: RequestedItem[] = [];
        for (const ref of opts.app) items.push({ kind: "app", id: await resolveApp(ctx.client, tid, ref) });
        for (const ref of opts.stack) items.push({ kind: "stack", id: await resolveGroupId(ctx.client, tid, ref, true) });
        for (const ref of opts.group) items.push({ kind: "group", id: await resolveGroupId(ctx.client, tid, ref, false) });
        const run = await planRelocation(ctx.client, tid, {
          items,
          target_server_id: await resolveServer(ctx.client, tid, opts.to),
          options: {
            gate_before_cutover: Boolean(opts.gateBeforeCutover),
            auto_commit: opts.autoCommit,
            volumes: await warmChoices(ctx.client, tid, opts.warm),
          },
        });
        printMutation(
          program,
          summary(run),
          `✓ relocation planned: ${run.id}\n  nothing has started; review it with \`reoclo relocate status ${run.id}\``,
        );
      },
    );

  g.command("run <id>")
    .description("start a planned relocation, or release a gate on a running one")
    .option("--plan-hash <hash>", "start the plan with exactly this hash")
    .option("--cutover", "approve the cutover gate")
    .option("--confirm-dns <record-plan-hash>", "confirm the manual DNS records with this hash were changed")
    .option("--resume", "resume a relocation that needs attention")
    .option("--yes", "skip the confirmation prompt")
    .action(
      async (
        id: string,
        opts: { planHash?: string; cutover?: boolean; confirmDns?: string; resume?: boolean; yes?: boolean },
      ) => {
        const modes = [opts.planHash, opts.cutover, opts.confirmDns, opts.resume].filter((m) => m !== undefined);
        if (modes.length !== 1) fail("pass exactly one of --plan-hash, --cutover, --confirm-dns or --resume", 2);
        const ctx = await bootstrap();
        const tid = await requireTenantId(ctx);
        const run = await getRelocation(ctx.client, tid, id);
        let next: Relocation;
        if (opts.planHash !== undefined) {
          await confirmed(opts.yes, `Start relocation ${id}? Writable services get a short maintenance window.`);
          const acknowledgements = { downtime: true, source_retention: true, scheduled_commit: true, post_cutover_data_loss: true };
          next = await act(ctx.client, tid, run, "run", { plan_revision: run.plan_revision, plan_hash: opts.planHash, acknowledgements });
        } else if (opts.cutover) {
          await confirmed(opts.yes, `Approve cutover for ${id}?`);
          next = await act(ctx.client, tid, run, "cutover");
        } else if (opts.confirmDns !== undefined) {
          await confirmed(opts.yes, `Confirm the DNS records for ${id} were changed?`);
          next = await act(ctx.client, tid, run, "confirm-dns", { record_plan_hash: opts.confirmDns, records_changed: true });
        } else {
          await confirmed(opts.yes, `Resume ${id}?`);
          next = await act(ctx.client, tid, run, "resume");
        }
        printMutation(program, summary(next), `✓ relocation ${next.id}: ${next.state}`);
      },
    );

  g.command("status [id]")
    .description("list relocations, or show one; --watch follows it until a decision is needed")
    .option("--watch", "follow events until a gate, attention or the end")
    .action(async (id: string | undefined, opts: { watch?: boolean }) => {
      const fmt = resolveFormat(globalOutput(program));
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      if (id === undefined) {
        const list = await listRelocations(ctx.client, tid);
        printList(list.items.map(summary), [
          { key: "id", label: "ID" },
          { key: "state", label: "STATE" },
          { key: "waiting", label: "WAITING" },
          { key: "actions", label: "ACTIONS" },
        ], fmt);
        return;
      }
      let run = await getRelocation(ctx.client, tid, id);
      if (!opts.watch) {
        printObject({ ...summary(run), record_plan_hash: run.record_plan_hash ?? "" }, fmt);
        return;
      }
      let cursor = 0;
      for (;;) {
        const page = await getEvents(ctx.client, tid, id, cursor);
        cursor = page.next_after;
        for (const e of page.items) {
          if (fmt === "json" || fmt === "yaml") printObject({ ...e }, fmt);
          else process.stdout.write(`${e.created_at} ${e.message}\n`);
        }
        run = await getRelocation(ctx.client, tid, id);
        if (needsOperator(run) && page.items.length < 200) break;
        await Bun.sleep(WATCH_INTERVAL_MS);
      }
      printObject({ ...summary(run), record_plan_hash: run.record_plan_hash ?? "" }, fmt);
    });

  g.command("rollback <id>")
    .description("roll a relocation back to its source")
    .option("--discard-target-data", "after DNS changed: discard writes made on the target")
    .option("--yes", "skip the confirmation prompt")
    .action(async (id: string, opts: { discardTargetData?: boolean; yes?: boolean }) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const run = await getRelocation(ctx.client, tid, id);
      if (run.dns_switch_started_at !== null && !opts.discardTargetData) {
        fail("DNS already moved to the target; pass --discard-target-data to accept losing its writes", 2);
      }
      await confirmed(opts.yes, `Roll back ${id}?`);
      const extra = opts.discardTargetData
        ? { data_policy: "discard_target", acknowledged_relocation_id: run.id, discard_target_writes: true }
        : {};
      const next = await act(ctx.client, tid, run, "rollback", extra);
      printMutation(program, summary(next), `✓ rollback requested: ${next.id}`);
    });

  g.command("commit <id>")
    .description("remove the retained source copies; rollback is no longer possible")
    .option("--yes", "skip the confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      const ctx = await bootstrap();
      const tid = await requireTenantId(ctx);
      const run = await getRelocation(ctx.client, tid, id);
      await confirmed(opts.yes, `Commit ${id}? The source containers and volumes are removed for good.`);
      const next = await act(ctx.client, tid, run, "commit", { irreversible_cleanup: true });
      printMutation(program, summary(next), `✓ commit requested: ${next.id}`);
    });
}
