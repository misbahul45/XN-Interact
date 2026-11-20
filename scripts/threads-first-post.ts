import { readFileSync } from "node:fs";
import { App } from "../src/app.ts";
import { loadConfig } from "../src/bootstrap/config.ts";
import { invoke } from "../src/routing/gateway.ts";

const OP = "content.publish.text";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const [cmd] = process.argv.slice(2);
const app = await App.open(loadConfig());
let code = 0;
try {
  if (cmd === "plan") {
    const file = flag("--text-file");
    if (!file) throw new Error("usage: threads-first-post.ts plan --text-file <file> [--account <id>]");
    const text = readFileSync(file, "utf8").replace(/\s+$/, "");
    const accounts = app.accounts.list({ provider: "threads" }).filter((a) => a.state === "connected");
    const accountId = flag("--account") ?? (accounts.length === 1 ? accounts[0]!.id : undefined);
    if (!accountId) throw new Error(`pass --account; connected threads accounts: ${accounts.map((a) => `${a.id} (${a.display_name})`).join(", ") || "none"}`);
    if (!app.acceptance.armed(accountId, OP)) {
      throw new Error(`${OP} is not armed for ${accountId}. The owner arms ONE run in a terminal:\n  bun run src/cli.ts accept threads ${OP} --account ${accountId}`);
    }
    const draft = await invoke(app, "social_content_create", { text });
    if (!draft.ok) throw new Error(`draft failed: ${draft.error?.code} ${draft.error?.message}`);
    const plan = await invoke(app, "social_content_publish", { mode: "plan", account_ids: [accountId], draft_id: (draft.data as { draft_id: string }).draft_id });
    if (!plan.ok) throw new Error(`plan failed: ${plan.error?.code} ${plan.error?.message}`);
    const d = plan.data as { plan_id: string; plan_hash?: string; approval: { approval_id: string; expires_at?: string } };
    const ap = app.approvals.get(d.approval.approval_id);
    out({ account_id: accountId, draft_id: (draft.data as { draft_id: string }).draft_id, plan_id: d.plan_id, plan_hash: ap.plan_hash, approval_id: ap.id, approval_expires_at: ap.expires_at, text, chars: [...text].length });
  } else if (cmd === "execute") {
    const planId = flag("--plan-id");
    if (!planId) throw new Error("usage: threads-first-post.ts execute --plan-id <id> [--operation-id <id>]");
    const operationId = flag("--operation-id") ?? `op-threads-first-post-${Date.now()}`;
    const r = await invoke(app, "social_content_publish", { mode: "execute", plan_id: planId, operation_id: operationId });
    out({ ok: r.ok, operation_id: operationId, data: r.data ?? null, error: r.error ?? null, bridge: (r as { meta?: { bridge?: unknown } }).meta?.bridge ?? null });
    code = r.ok ? 0 : 1;
  } else if (cmd === "status") {
    const planId = flag("--plan-id");
    const ap = planId ? app.db.all("SELECT id, plan_id, decision, expires_at FROM approvals WHERE plan_id = ?", planId) : [];
    out({ approvals: ap, acceptance: app.acceptance.list(5) });
  } else {
    throw new Error("usage: threads-first-post.ts plan|execute|status");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  code = 1;
} finally {
  app.close();
}
process.exit(code);
