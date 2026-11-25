import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixtureConsent } from "../../src/providers/fixture/adapter.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { brokerCall } from "../../src/browser/ipc.ts";
import { ExtractionStore } from "../../src/extraction/store.ts";
import { Db } from "../../src/storage/db.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";

const BRIDGE = process.env.XN_BRIDGE_TEST_ROOT ?? join(homedir(), "code", "XN-Bridge");
const PY = process.env.XN_BRIDGE_TEST_PYTHON ?? join(BRIDGE, ".venv", "bin", "python");
const bridgeSource = join(BRIDGE, "src");
const available = existsSync(PY);

let bridge: Client;
let interact: Client;
let bridgeHome: string;
let interactHome: string;
let interactEnv: Record<string, string>;

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await c.callTool({ name, arguments: args });
  if (r.structuredContent) return r.structuredContent as any;
  const text = String((r.content as { text: string }[])[0]?.text ?? "{}");
  try {
    return JSON.parse(text);
  } catch {
    if (r.isError) return { ok: false, error_text: text };
    throw new Error(`${name}: unparseable result`);
  }
}

function py(...args: string[]): string {
  const p = Bun.spawnSync([PY, ...args], { env: { ...process.env, XN_BRIDGE_HOME: bridgeHome, XN_BRIDGE_HOST: "claude", PYTHONPATH: bridgeSource }, cwd: BRIDGE });
  if (p.exitCode !== 0) throw new Error(`python ${args.join(" ")} failed: ${p.stderr.toString().slice(-800)}`);
  return p.stdout.toString();
}

function interactChild(...args: string[]): string {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "tests/fixtures/child.ts"), interactHome, ...args]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}

beforeAll(async () => {
  if (!available) return;
  const base = tempHome();
  bridgeHome = join(base, "bridge");
  interactHome = join(base, "interact");
  mkdirSync(interactHome, { recursive: true });
  interactEnv = { ...testEnv(interactHome, { XN_INTERACT_KEYRING: "file", XN_INTERACT_FIXTURE_PROVIDER: "1", XN_INTERACT_FIXTURE_STATE: join(interactHome, "remote.json") }), PATH: process.env.PATH ?? "" };
  py(join(ROOT, "tests/fixtures/bridge_human.py"), bridgeHome, "probe", process.execPath, join(ROOT, "src/main.ts"), JSON.stringify(interactEnv));
  py(join(ROOT, "tests/fixtures/bridge_human.py"), bridgeHome, "init");
  bridge = new Client({ name: "host-sim", version: "1.0.0" });
  await bridge.connect(new StdioClientTransport({ command: PY, args: ["-m", "xnbridge.server"], cwd: BRIDGE, env: { XN_BRIDGE_HOME: bridgeHome, XN_BRIDGE_HOST: "claude", PATH: process.env.PATH ?? "", PYTHONPATH: bridgeSource } }));
  interact = new Client({ name: "host-sim", version: "1.0.0" });
  await interact.connect(new StdioClientTransport({ command: process.execPath, args: ["run", join(ROOT, "src/main.ts")], env: interactEnv }));
}, 120_000);

afterAll(async () => {
  await bridge?.close();
  await interact?.close();
});

describe.skipIf(!available)("host-mediated flow across XN-Bridge and XN-Interact", () => {
  test("route a dataset, call XN-Interact over MCP, and register compact coverage evidence", async () => {
    const website = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
      '<main><article data-xn-record="one"><p data-xn-field="title">Fixture opportunity</p></article><p data-xn-end>End of results</p></main>',
      { headers: { "content-type": "text/html" } },
    ) });
    const cfg = loadConfig(interactEnv);
    const db = new Db(cfg.dbPath);
    try {
      new ExtractionStore(db, true).register({ id: "bridge-source", url: `${website.url.origin}/data`, path_prefix: "/data",
        permission: "owner_controlled", fields: [{ name: "title", type: "string" }] });
      const route = await call(bridge, "route_intent", { text: "Kumpulkan dataset dari situs yang diotorisasi" });
      expect(route.intent).toBe("data.collect");
      expect(route.providers["data.collect"].selected).toBe("xn-interact:social_extract_start");
      const resolution = await call(bridge, "capability_resolve", { capability: "data.collect" });
      expect(resolution.selected.runtime.browser_mode).toBe("headless");
      const result = await call(interact, resolution.selected.tool, { request_id: "bridge-browser-fixture",
        objective: "Collect fixture opportunities", sources: ["bridge-source"], entity_type: "listing",
        fields: [{ name: "title", type: "string" }], coverage: "all_accessible" });
      expect(result.ok).toBe(true);
      const id = result.data.run_id;
      let view = result.data;
      for (let i = 0; i < 100 && ["queued", "running"].includes(view.status); i++) {
        await Bun.sleep(100);
        view = (await call(interact, "social_workflows_status", { run_id: id })).data;
      }
      expect(view.coverage).toMatchObject({ status: "COMPLETE_WITHIN_SCOPE", unique_records: 1, expected_total: null });
      const workflow = await call(bridge, "workflow_create", { domain: "data", title: "Browser fixture dataset" });
      expect(workflow.workflow_id ?? workflow.id).toBeTruthy();
      const evidence = await call(bridge, "evidence_register", {
        workflow_id: workflow.workflow_id ?? workflow.id, claim: "Local fixture collection observed one record",
        origin: "tool_output", source_ref: `social://datasets/${id}`, content: JSON.stringify(view), verification: "VERIFIED", provider: "xn-interact",
      });
      expect(evidence.verification).toBe("VERIFIED");
    } finally {
      await brokerCall(cfg, "stop");
      await website.stop(true);
      db.close();
    }
  }, 30_000);

  test("route, workflow, plan, both approvals, execute once, evidence, result, completion", async () => {
    const route = await call(bridge, "route_intent", { text: "posting ke linkedin: rilis fitur baru XN-Interact" });
    expect(route.domain).toBe("social");
    expect(route.intent).toBe("social.publish");
    expect(route.providers["social.content.publish"].selected).toBe("xn-interact:social_content_publish");
    const wf = await call(bridge, "workflow_create", { domain: "social", title: "e2e publish" });
    const wid = wf.workflow_id ?? wf.id;
    const resolved = await call(bridge, "capability_resolve", { capability: "social.content.publish" });
    expect(resolved.selected.provider).toBe("xn-interact:social_content_publish");
    expect(resolved.selected.requires_approval).toBe(true);

    const start = await call(interact, "social_auth_connect", { provider: "fixture" });
    const c = fixtureConsent(start.data.auth_url);
    const u = new URL(c.redirect_uri);
    u.searchParams.set("code", c.code!);
    u.searchParams.set("state", c.state);
    expect((await fetch(u)).status).toBe(200);
    const accounts = (await call(interact, "social_accounts_list", { provider: "fixture" })).data.accounts as { account_id: string }[];
    const ids = accounts.map((a) => a.account_id);

    await call(bridge, "workflow_checkpoint", { workflow_id: wid, stage: "connect", status: "DONE", new_state: "RUNNING" });
    await call(bridge, "domain_action", { domain: "social", action: "targets.set", workflow_id: wid, payload: { account_ids: ids, providers: ["fixture"] } });
    await call(bridge, "workflow_checkpoint", { workflow_id: wid, stage: "inspect", status: "DONE" });
    await call(bridge, "workflow_checkpoint", { workflow_id: wid, stage: "collect", status: "SKIPPED" });

    const draft = await call(interact, "social_content_create", { text: "Rilis fitur baru XN-Interact" });
    const plan = (await call(interact, "social_content_publish", { mode: "plan", account_ids: ids, draft_id: draft.data.draft_id })).data;
    await call(bridge, "workflow_checkpoint", { workflow_id: wid, stage: "prepare", status: "DONE" });
    await call(bridge, "domain_action", { domain: "social", action: "plan.record", workflow_id: wid, payload: { plan_id: plan.plan_id, plan_hash: plan.plan_hash, operation: "social_content_publish", account_ids: ids, interact_approval_id: plan.approval.approval_id } });
    const target = `https://xn-interact.invalid/plans/${plan.plan_id}`;
    const bap = await call(bridge, "approval_prepare", { workflow_id: wid, action_kind: "social.social_content_publish", target, payload: { plan_id: plan.plan_id, plan_hash: plan.plan_hash, operation: "social_content_publish", account_ids: ids, interact_approval_id: plan.approval.approval_id } });
    const bridgeApproval = bap.approval_id;

    const early = await call(interact, "social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-e2e-early" });
    expect(early.error.code).toBe("APPROVAL_REQUIRED");

    expect(py(join(ROOT, "tests/fixtures/bridge_human.py"), bridgeHome, "grant", bridgeApproval).trim()).toBe("GRANTED");
    const onlyBridge = await call(interact, "social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-e2e-bridge-only" });
    expect(onlyBridge.error.code).toBe("APPROVAL_REQUIRED");
    expect(interactChild("approve", plan.approval.approval_id)).toBe("approved");

    const begin = await call(bridge, "execution_record", { op: "begin", workflow_id: wid, capability: "social.content.publish", provider: "xn-interact:social_content_publish", idempotency_key: "e2e-1", target, approval_id: bridgeApproval });
    const exec = await call(interact, "social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-e2e-0001" });
    expect(exec.ok).toBe(true);
    expect(exec.data.status).toBe("succeeded");
    expect(exec.meta.bridge).toEqual({ outcome: "SUCCEEDED", error_class: "NONE" });

    const ev = await call(bridge, "evidence_register", { workflow_id: wid, claim: "XN-Interact published the plan to every target", origin: "tool_output", source_ref: exec.meta.result_ref, content: JSON.stringify(exec), verification: "VERIFIED", provider: "xn-interact" });
    expect(ev.verification).toBe("VERIFIED");
    const fin = await call(bridge, "execution_record", { op: "finish", execution_id: begin.execution_id ?? begin.id, outcome: exec.meta.bridge.outcome, error_class: exec.meta.bridge.error_class, evidence_ids: [ev.evidence_id] });
    expect(fin.ok).toBe(true);
    await call(bridge, "workflow_checkpoint", { workflow_id: wid, stage: "act", status: "DONE" });
    await call(bridge, "domain_action", { domain: "social", action: "result.record", workflow_id: wid, payload: { plan_id: plan.plan_id, run_id: exec.data.run_id, run_state: exec.data.status, targets: exec.data.targets.map((t: any) => ({ account_id: t.account_id, outcome: t.state, provider_ref: t.provider_ref, url: t.url, evidence_id: ev.evidence_id })) } });
    await call(bridge, "workflow_checkpoint", { workflow_id: wid, stage: "verify", status: "DONE", new_state: "COMPLETED" });
    const final = await call(bridge, "workflow_get", { workflow_id: wid });
    expect(final.state).toBe("COMPLETED");

    const dup = await call(bridge, "execution_record", { op: "begin", workflow_id: wid, capability: "social.content.publish", provider: "xn-interact:social_content_publish", idempotency_key: "e2e-2", target, approval_id: bridgeApproval });
    expect(dup.ok).toBe(false);
    expect(dup.error_text).toContain("COMPLETED");
    const remote = JSON.parse(readFileSync(join(interactHome, "remote.json"), "utf8"));
    expect(remote.writeCalls).toHaveLength(ids.length);
  }, 120_000);

  test("a crash during execute is reconciled consistently by both servers without a duplicate", async () => {
    const wf = await call(bridge, "workflow_create", { domain: "social", title: "e2e crash" });
    const wid = wf.workflow_id ?? wf.id;
    const accounts = (await call(interact, "social_accounts_list", { provider: "fixture" })).data.accounts as { account_id: string }[];
    const ids = accounts.map((a) => a.account_id).slice(0, 1);
    await call(bridge, "workflow_checkpoint", { workflow_id: wid, stage: "connect", status: "SKIPPED", new_state: "RUNNING" });
    await call(bridge, "domain_action", { domain: "social", action: "targets.set", workflow_id: wid, payload: { account_ids: ids } });
    const draft = await call(interact, "social_content_create", { text: "crash in the middle" });
    const plan = (await call(interact, "social_content_publish", { mode: "plan", account_ids: ids, draft_id: draft.data.draft_id })).data;
    const target = `https://xn-interact.invalid/plans/${plan.plan_id}`;
    const bap = await call(bridge, "approval_prepare", { workflow_id: wid, action_kind: "social.social_content_publish", target, payload: { plan_id: plan.plan_id, plan_hash: plan.plan_hash } });
    py(join(ROOT, "tests/fixtures/bridge_human.py"), bridgeHome, "grant", bap.approval_id);
    interactChild("approve", plan.approval.approval_id);
    const remotePath = join(interactHome, "remote.json");
    const before = JSON.parse(readFileSync(remotePath, "utf8"));
    const writesBefore = before.writeCalls.length;
    before.faults = ["crash_after_apply"];
    await Bun.write(remotePath, JSON.stringify(before));
    const begin = await call(bridge, "execution_record", { op: "begin", workflow_id: wid, capability: "social.content.publish", provider: "xn-interact:social_content_publish", idempotency_key: "e2e-crash-1", target, approval_id: bap.approval_id });
    await expect(interact.callTool({ name: "social_content_publish", arguments: { mode: "execute", plan_id: plan.plan_id, operation_id: "op-e2e-crash-0001" } })).rejects.toThrow();
    const unknown = await call(bridge, "execution_record", { op: "finish", execution_id: begin.execution_id ?? begin.id, outcome: "OUTCOME_UNKNOWN", error_class: "UNKNOWN_SIDE_EFFECT" });
    expect(unknown.ok).toBe(true);
    await interact.close().catch(() => {});
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(interactHome, "xn-interact.sqlite"));
    db.run("UPDATE worker_leases SET expires_at = ?", [new Date(Date.now() - 1000).toISOString()]);
    db.close();
    interact = new Client({ name: "host-sim", version: "1.0.0" });
    await interact.connect(new StdioClientTransport({ command: process.execPath, args: ["run", join(ROOT, "src/main.ts")], env: interactEnv }));
    const replay = await call(interact, "social_content_publish", { mode: "execute", plan_id: plan.plan_id, operation_id: "op-e2e-crash-0001" });
    expect(replay.data.status).toBe("succeeded");
    expect(replay.meta.warnings?.[0]).toContain("already executed");
    const ev = await call(bridge, "evidence_register", { workflow_id: wid, claim: "reconciled publish found at the provider", origin: "tool_output", source_ref: replay.meta.result_ref, content: replay, verification: "VERIFIED" });
    const rec = await call(bridge, "execution_record", { op: "reconcile", execution_id: begin.execution_id ?? begin.id, outcome: "SUCCEEDED", evidence_ids: [ev.evidence_id], detail: { note: "xn-interact reconciled by client token" } });
    expect(rec.ok).toBe(true);
    const after = JSON.parse(readFileSync(remotePath, "utf8"));
    expect(after.writeCalls.length - writesBefore).toBe(1);
  }, 120_000);
});
