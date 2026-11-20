import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { App } from "../src/app.ts";
import { loadConfig } from "../src/bootstrap/config.ts";
import { MemoryKeyring } from "../src/identity/keyring.ts";
import { configureLogger } from "../src/observability/logger.ts";
import { FixtureAdapter, FixtureRemote, fixtureConsent } from "../src/providers/fixture/adapter.ts";
import { invoke } from "../src/routing/gateway.ts";
import type { ToolResponse } from "../src/contracts/envelope.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const logs: string[] = [];
configureLogger("debug", (l) => logs.push(l));

export function tempHome(): string {
  const base = join(ROOT, ".cache", "test-homes");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "h-"));
}

export interface TestCtx {
  app: App;
  remote: FixtureRemote;
  home: string;
  keyring: MemoryKeyring;
  call: (tool: string, args?: Record<string, unknown>) => Promise<ToolResponse<any>>;
}

export function testEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { XN_INTERACT_HOME: home, XN_INTERACT_ENV: "test", XN_INTERACT_KEYRING: "memory", XN_INTERACT_CALLBACK_PORT: "0", XN_INTERACT_HTTPS_PORT: "0", XN_INTERACT_TICK_MS: "0", XN_INTERACT_LOG_LEVEL: "debug", XN_INTERACT_MEDIA_ROOTS: join(home, "inbox"), ...extra };
}

export async function openApp(home = tempHome(), keyring = new MemoryKeyring(new Map())): Promise<TestCtx> {
  const config = loadConfig(testEnv(home));
  const remote = new FixtureRemote(join(home, "remote.json"));
  const app = await App.open(config, { keyring, testAdapters: [new FixtureAdapter(remote)], testClients: { fixture: { client_id: "fixture-client" } } });
  return { app, remote, home, keyring, call: (tool, args = {}) => invoke(app, tool, args) };
}

export async function connect(ctx: TestCtx, opts: { scopes?: string[]; deny?: boolean; mode?: "connect" | "upgrade"; account_id?: string } = {}): Promise<{ attempt: any; status: any; callback: Response }> {
  const start = await ctx.call("social_auth_connect", { provider: "fixture", mode: opts.mode ?? "connect", account_id: opts.account_id });
  if (!start.ok) throw new Error(JSON.stringify(start.error));
  const consent = fixtureConsent(start.data.auth_url, { scopes: opts.scopes, deny: opts.deny });
  const u = new URL(consent.redirect_uri);
  if (consent.code) u.searchParams.set("code", consent.code);
  if (consent.error) u.searchParams.set("error", consent.error);
  u.searchParams.set("state", consent.state);
  const callback = await fetch(u);
  const status = await ctx.call("social_auth_status", { attempt_id: start.data.attempt_id });
  return { attempt: start.data, status: status.data, callback };
}

export function approve(ctx: TestCtx, approvalId: string): void {
  const a = ctx.app.approvals.get(approvalId);
  ctx.app.approvals.decideFromTrustedTerminal(approvalId, "approved", { tty: true, user: "test-owner", confirmed_hash_prefix: a.plan_hash.slice(0, 8) });
}

export async function accounts(ctx: TestCtx): Promise<{ member: string; page: string }> {
  const r = await ctx.call("social_accounts_list", { provider: "fixture" });
  const list = r.data.accounts as { account_id: string; account_type: string }[];
  return { member: list.find((a) => a.account_type === "member")!.account_id, page: list.find((a) => a.account_type === "page")!.account_id };
}

export async function publish(ctx: TestCtx, accountIds: string[], text: string, extra: Record<string, unknown> = {}): Promise<{ plan: any; exec: ToolResponse<any> }> {
  const draft = await ctx.call("social_content_create", { text, ...((extra.draft as Record<string, unknown>) ?? {}) });
  const plan = await ctx.call("social_content_publish", { mode: "plan", account_ids: accountIds, draft_id: draft.data.draft_id, ...((extra.plan as Record<string, unknown>) ?? {}) });
  if (!plan.ok) throw new Error(JSON.stringify(plan.error));
  approve(ctx, plan.data.approval.approval_id);
  const exec = await ctx.call("social_content_publish", { mode: "execute", plan_id: plan.data.plan_id, operation_id: `op-${crypto.randomUUID()}` });
  return { plan: plan.data, exec };
}
