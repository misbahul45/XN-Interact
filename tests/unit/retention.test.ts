import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backup, purge, verifyBackup } from "../../src/storage/retention.ts";
import { accounts, approve, connect, openApp, publish, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

const DAY = 86_400_000;
const POLICY = { audit_days: 30, terminal_run_days: 30, plan_days: 10 };

function age(ctx: TestCtx, table: string, col: string, days: number, where = "1=1") {
  ctx.app.db.run(`UPDATE ${table} SET ${col} = ? WHERE ${where}`, new Date(Date.now() - days * DAY).toISOString());
}

describe("retention", () => {
  test("old terminal data is purged; accounts, grants, pending approvals and unknown outcomes are never touched", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member, page } = await accounts(ctx);
    const done = await publish(ctx, [member], "old and finished");
    ctx.remote.faults = ["unprovable_drop"];
    ctx.remote.save();
    const unknown = await publish(ctx, [page], "unknown outcome");
    expect(unknown.exec.data.status).toBe("unknown_outcome");
    const draft = await ctx.call("social_content_create", { text: "pending approval" });
    const pending = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.data.draft_id });
    age(ctx, "audit_events", "at", 60);
    age(ctx, "workflow_runs", "updated_at", 60);
    age(ctx, "execution_plans", "created_at", 60);
    age(ctx, "approvals", "created_at", 60);
    const deleted = purge(ctx.app.db, ctx.app.config.mediaDir, POLICY);
    expect(deleted.audit_events).toBeGreaterThan(0);
    expect(deleted.workflow_runs).toBe(1);
    expect(() => ctx.app.engine.run(done.exec.data.run_id)).toThrow();
    expect(ctx.app.engine.run(unknown.exec.data.run_id).state).toBe("unknown_outcome");
    expect(ctx.app.approvals.get(pending.data.approval.approval_id).decision).toBe("pending");
    expect(ctx.app.accounts.list()).toHaveLength(2);
    expect(ctx.app.accounts.grant(member)).not.toBeNull();
  });

  test("a run with a pending or unknown intent survives and so do accounts and grants", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { page, member } = await accounts(ctx);
    ctx.remote.faults = ["unprovable_drop"];
    ctx.remote.save();
    const unknown = await publish(ctx, [page], "stays");
    const draft = await ctx.call("social_content_create", { text: "pending" });
    const pending = await ctx.call("social_content_publish", { mode: "plan", account_ids: [member], draft_id: draft.data.draft_id });
    age(ctx, "workflow_runs", "updated_at", 400);
    age(ctx, "execution_plans", "created_at", 400);
    age(ctx, "approvals", "created_at", 400);
    purge(ctx.app.db, ctx.app.config.mediaDir, POLICY);
    expect(ctx.app.engine.run(unknown.exec.data.run_id).state).toBe("unknown_outcome");
    expect(ctx.app.approvals.get(pending.data.approval.approval_id).decision).toBe("pending");
    expect(ctx.app.plans.get(pending.data.plan_id)).toBeTruthy();
    expect(ctx.app.accounts.list()).toHaveLength(2);
    expect(ctx.app.accounts.grant(member)).not.toBeNull();
  });

  test("finished runs older than the policy disappear together with their steps and intents", async () => {
    ctx = await openApp();
    await connect(ctx);
    const { member } = await accounts(ctx);
    const { exec } = await publish(ctx, [member], "to be purged");
    age(ctx, "workflow_runs", "updated_at", 60);
    age(ctx, "execution_plans", "created_at", 60);
    age(ctx, "approvals", "created_at", 60);
    const deleted = purge(ctx.app.db, ctx.app.config.mediaDir, POLICY);
    expect(deleted.workflow_runs).toBe(1);
    expect(ctx.app.db.get<{ n: number }>("SELECT count(*) AS n FROM workflow_steps")!.n).toBe(0);
    expect(ctx.app.db.get<{ n: number }>("SELECT count(*) AS n FROM operation_intents")!.n).toBe(0);
    expect(deleted.execution_plans).toBe(1);
    expect(() => ctx.app.engine.run(exec.data.run_id)).toThrow();
  });

  test("expired staged media loses its file and its row", async () => {
    ctx = await openApp();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    await Bun.write(`${ctx.home}/inbox/a.png`, png);
    const staged = await ctx.call("social_media_upload", { path: `${ctx.home}/inbox/a.png` });
    const file = join(ctx.app.config.mediaDir, `${staged.data.sha256}.png`);
    expect(existsSync(file)).toBe(true);
    age(ctx, "media_assets", "expires_at", 1);
    expect(purge(ctx.app.db, ctx.app.config.mediaDir, POLICY).media_assets).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});

describe("backup", () => {
  test("is a verified, private copy that contains no plaintext credential and never overwrites", async () => {
    ctx = await openApp();
    ctx.remote.tokenPrefix = "CANARYBKP9";
    ctx.remote.save();
    await connect(ctx);
    const { member } = await accounts(ctx);
    await publish(ctx, [member], "backup me");
    const dest = join(ctx.home, "backup.sqlite");
    const b = backup(ctx.app.db, dest);
    expect(b.bytes).toBeGreaterThan(0);
    expect((await Bun.file(dest).stat()).mode & 0o777).toBe(0o600);
    expect(readFileSync(dest).toString("latin1").includes("CANARYBKP9")).toBe(false);
    expect(verifyBackup(dest)).toEqual({ ok: true, problems: [], migrations: 9 });
    expect(() => backup(ctx.app.db, dest)).toThrow(/refusing to overwrite/);
  });

  test("verification catches tampering and a missing checksum", async () => {
    ctx = await openApp();
    const dest = join(ctx.home, "b2.sqlite");
    backup(ctx.app.db, dest);
    const bytes = readFileSync(dest);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) & 0xff;
    writeFileSync(dest, bytes);
    const v = verifyBackup(dest);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toContain("sha256 mismatch");
    expect(verifyBackup(join(ctx.home, "none.sqlite")).ok).toBe(false);
  });
});
