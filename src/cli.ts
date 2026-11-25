#!/usr/bin/env bun
import { copyFileSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { hostPublicly } from "./content/public-media.ts";
import { App } from "./app.ts";
import { loadConfig } from "./bootstrap/config.ts";
import { onShutdown } from "./bootstrap/lifecycle.ts";
import { assertRuntime } from "./bootstrap/runtime.ts";
import { GatewayError } from "./contracts/errors.ts";
import { configureLogger } from "./observability/logger.ts";
import { publicApproval } from "./policy/approvals.ts";
import { DEFAULT_PER_DAY, DEFAULT_TOTAL, GRANTABLE_OPERATIONS, publicGrant } from "./policy/grants.ts";
import { SIGNABLE_OPERATIONS, publicSignoff } from "./policy/signoffs.ts";
import { parseRequest, ReaderError } from "./reader/rules.ts";
import { runWebRead } from "./reader/service.ts";
import { brokerCall, brokerCommand, brokerEnv, ensureBroker } from "./browser/ipc.ts";
import { runId as extractionRunId, sourceId } from "./extraction/contracts.ts";
import { ingestOwnerExport, readOwnerDocument } from "./extraction/ingest.ts";
import { deleteDataset } from "./extraction/datasets.ts";
import { health, invoke } from "./routing/gateway.ts";
import { DEFAULT_RETENTION, backup, purge, verifyBackup } from "./storage/retention.ts";

const USAGE = `xn-interact <command>
  doctor                         readiness report
  browser register <manifest> | revoke <source> | sources
  broker start | stop | restart | status
  auth setup <source> | reauthenticate <source> | status
  extract resume <run-id>
  datasets register <source-manifest> | ingest <manifest> <file> | delete <dataset-ref>
  vault init | status | rotate   manage the OS-keyring vault key
  app set <provider> [--products a,b] [--approval-state STATE]   store operator app credentials (prompted, hidden)
  login <provider> [--open] [--reset]   one step: console link, hidden prompt for the app id and secret, then log in
  first-post <provider> --text-file <file> [--image-file <jpeg>]   owner only, ONE command: arm, show the exact plan, approve, publish and read back (needs a terminal)
  media url <jpeg> | media host <jpeg>   Instagram images: print where the JPEG must be served, or copy it into XN_INTERACT_PUBLIC_MEDIA_DIR, commit and push it (host needs a terminal and your typed confirmation)
  accept <provider> <operation> --account <id>   owner only: arm ONE real run of an unverified operation (needs a terminal)
  accept list | accept revoke <id>
  grant create <provider> <operation> --account <id> [--hours 24] [--per-day 3] [--max-total 10]   owner only: a capped, time-boxed standing grant so the MCP can publish plain text without a terminal approval per post (needs a terminal)
  grant list | grant revoke <grant_id>
  evidence sign <provider> <operation> --account <id> [--days 90]   owner only: after a real approved acceptance run worked, sign it so the operation runs after an approval or a standing grant without a new arming (needs a terminal)
  evidence list | evidence revoke <signoff_id>
  providers                      per provider: login readiness, the redirect URI to register, scopes, app and account status
  connect <provider> [--open] [--https|--loopback]    log in with the provider's official OAuth page (prints the URL, waits for your consent, shows the result)
  web-read linkedin-jobs --keywords <text> --geo <geoId> [--days 30] [--max 25] | web-read linkedin-feed [--max 25] [--scrolls 2]   READ-ONLY: read LinkedIn pages in your own logged-in Chrome (debug port on loopback). No login, no clicks, no cookies stored; stops at any CAPTCHA or checkpoint. See docs/web-reader.md
  approvals                      list pending approvals
  approve <approval_id>          approve in this terminal (shows the plan, asks for the plan hash prefix)
  reject <approval_id>           reject in this terminal
  budget set <account_id> <operation|*> [--max-calls N] [--max-cost X]
  budget show
  worker                         run due workflows until stopped (for a systemd user service)
  recover                        mark interrupted writes unknown and reconcile them read-only
  audit export                   scrubbed audit log on stdout
  retention run [--audit-days N] [--run-days N] [--plan-days N]   purge expired and old data (never accounts, grants, pending approvals, unknown outcomes)
  backup <file>                  consistent database copy (secrets stay encrypted; the vault key is not included)
  backup verify <file>           integrity, migrations and sha256 of a backup`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireTty(what: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${what} needs an interactive terminal; run it yourself, not through an agent or a pipe`);
}

async function hidden(question: string): Promise<string> {
  requireTty("secret entry");
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const CONSOLES: Record<string, string> = {
  threads: "https://developers.facebook.com/apps/",
  instagram: "https://developers.facebook.com/apps/",
  facebook: "https://developers.facebook.com/apps/",
  tiktok: "https://developers.tiktok.com/apps/",
  x: "https://developer.x.com/en/portal/dashboard",
  linkedin: "https://www.linkedin.com/developers/apps",
  reddit: "https://www.reddit.com/prefs/apps",
};

async function storeApp(app: App, provider: string, rest: string[]): Promise<void> {
  const adapter = app.providers.get(provider);
  const clientId = await hidden(`${provider} client id: `);
  const secret = await hidden(`${provider} client secret (empty if public client): `);
  if (!clientId.trim()) throw new Error("a client id is required");
  let configId: string | null = null;
  if (adapter.oauth.requires_config_id) {
    configId = prompt(`${provider} login configuration id (config_id, not a secret): `)?.trim() || null;
    if (!configId) throw new Error(`a login configuration id (config_id) is required for ${provider}`);
  }
  const products = (flag(rest, "--products") ?? "").split(",").filter(Boolean);
  await app.apps.set(provider, { client_id: clientId.trim(), client_secret: secret.trim() || null, config_id: configId }, products, flag(rest, "--approval-state") ?? "UNVERIFIED");
  app.resolver.invalidate();
  console.log(`stored ${provider} app credentials in the keyring; products: ${products.join(", ") || "none"}`);
}

async function runConnect(app: App, provider: string, rest: string[]): Promise<number> {
  const redirect = rest.includes("--https") ? "https" : rest.includes("--loopback") ? "loopback" : undefined;
  const started = await app.broker.start({ provider, mode: "connect", redirect });
  console.log(`auth_url: ${started.auth_url}`);
  for (const w of (started.warnings as string[]) ?? []) console.log(`note: ${w}`);
  console.log(`redirect_uri: ${started.redirect_uri}   (register exactly this in the provider console)`);
  console.log(`scopes: ${(started.requested_scopes as string[]).join(", ")}`);
  if (rest.includes("--open")) Bun.spawn(["xdg-open", String(started.auth_url)], { stdout: "ignore", stderr: "ignore" });
  console.log("waiting for your consent in the browser (up to 10 minutes)...");
  const attempt = String(started.attempt_id);
  for (;;) {
    const st = app.broker.status(attempt);
    if (st.status !== "pending" && st.status !== "exchanging") {
      const accountsOut = (st.account_ids as string[]).map((id) => {
        const a = app.accounts.get(id);
        return { account_id: id, provider: a?.provider, display_name: a?.display_name, account_type: a?.account_type, state: a?.state };
      });
      console.log(JSON.stringify({ status: st.status, error: st.error, missing_scopes: st.missing_scopes, accounts: accountsOut }, null, 2));
      return st.status === "connected" ? 0 : 1;
    }
    await Bun.sleep(500);
  }
}

async function acceptCmd(app: App, sub: string | undefined, rest: string[]): Promise<number> {
  if (sub === "list" || !sub) {
    const rows = app.acceptance.list();
    if (!rows.length) console.log("no acceptance runs");
    for (const r of rows) console.log(`${r.id}  ${r.state.padEnd(8)}  ${r.provider} ${r.operation}  account ${r.account_id}  armed ${r.armed_at}  expires ${r.expires_at}${r.consumed_at ? `  consumed ${r.consumed_at}` : ""}`);
    return 0;
  }
  if (sub === "revoke") {
    requireTty("revoking an acceptance run");
    const id = rest[0];
    if (!id) throw new Error("usage: xn-interact accept revoke <acceptance_id>");
    const ok = app.acceptance.revoke(id);
    if (ok) app.audit.record("human-cli", "acceptance.revoked", "revoked", { acceptance_id: id });
    console.log(ok ? `revoked ${id}` : `${id} is not armed`);
    return ok ? 0 : 1;
  }
  const provider = sub;
  const operation = rest[0];
  const accountId = flag(rest, "--account");
  if (!operation || !accountId) throw new Error("usage: xn-interact accept <provider> <operation> --account <account_id> [--minutes 60]");
  requireTty("arming an acceptance run");
  const adapter = app.providers.get(provider);
  if (adapter.testOnly && app.config.env !== "test") throw new Error(`${provider} is not a real provider`);
  const m = adapter.manifest.operations[operation];
  if (!m?.acceptance || m.verdict !== "UNVERIFIED") throw new Error(`${provider} ${operation} cannot be armed: it ${m ? (m.verdict === "UNVERIFIED" ? "has no implementation prepared for a real acceptance run" : `is already ${m.verdict}`) : "does not exist"}`);
  const account = app.accounts.get(accountId);
  if (!account || account.provider !== provider) throw new Error(`account ${accountId} is not a connected ${provider} account`);
  const grant = app.accounts.grant(accountId);
  if (account.state !== "connected" || !grant || grant.state !== "active") throw new Error(`account ${accountId} has no active grant; connect it first`);
  const minutes = Math.min(Number(flag(rest, "--minutes") ?? 60) || 60, 60);
  console.log(`\nAcceptance run for ${provider} ${operation}`);
  console.log(`  account: ${account.display_name} (${accountId})`);
  console.log(`  This operation is UNVERIFIED. Arming it allows exactly ONE real ${operation} on this account within ${minutes} minutes.`);
  const companions = (m.acceptance_with ?? []).filter((op) => adapter.manifest.operations[op]?.acceptance === true && adapter.manifest.operations[op]?.verdict === "UNVERIFIED");
  if (companions.length) console.log(`  The same workflow also writes with: ${companions.join(", ")}. They are armed together (one real request each).`);
  console.log("  It still needs a normal plan and your separate approval of the exact plan. Nothing is sent by arming.");
  const typed = prompt(`\nType the operation name (${operation}) to arm it:`);
  if (typed?.trim() !== operation) throw new Error("not confirmed");
  const row = app.acceptance.arm(provider, accountId, operation, minutes * 60_000);
  app.audit.record("human-cli", "acceptance.armed", "armed", { acceptance_id: row.id, provider, operation, expires_at: row.expires_at }, accountId);
  for (const extra of companions) {
    const r = app.acceptance.arm(provider, accountId, extra, minutes * 60_000);
    app.audit.record("human-cli", "acceptance.armed", "armed", { acceptance_id: r.id, provider, operation: extra, expires_at: r.expires_at, with: operation }, accountId);
  }
  app.resolver.invalidate(accountId);
  console.log(`\narmed ${row.id}${companions.length ? ` (+ ${companions.join(", ")})` : ""}; expires ${row.expires_at}`);
  return 0;
}

async function grantCmd(app: App, sub: string | undefined, rest: string[]): Promise<number> {
  const USAGE_GRANT = "usage: xn-interact grant create <provider> <operation> --account <account_id> [--hours 24] [--per-day 3] [--max-total 10] | grant list | grant revoke <grant_id>";
  if (sub === "list") {
    const rows = app.grants.list();
    if (!rows.length) console.log("no standing grants");
    else console.log(JSON.stringify(rows.map((g) => publicGrant(g, app.grants.usesToday(g.id))), null, 2));
    return 0;
  }
  if (sub === "revoke") {
    requireTty("revoking a standing grant");
    const id = rest[0];
    if (!id) throw new Error(USAGE_GRANT);
    const ok = app.grants.revoke(id);
    if (ok) app.audit.record("human-cli", "grant.revoked", "revoked", { grant_id: id });
    console.log(ok ? `revoked ${id}` : `nothing to revoke: ${id} is not an active grant`);
    return ok ? 0 : 1;
  }
  if (sub !== "create") throw new Error(USAGE_GRANT);
  const [provider, operation] = rest;
  const accountId = flag(rest, "--account");
  if (!provider || !operation || !accountId) throw new Error(USAGE_GRANT);
  requireTty("creating a standing grant");
  if (!GRANTABLE_OPERATIONS.has(operation)) throw new Error(`a standing grant can only cover: ${[...GRANTABLE_OPERATIONS].join(", ")}`);
  const adapter = app.providers.get(provider);
  if (adapter.testOnly && app.config.env !== "test") throw new Error(`${provider} is not a real provider`);
  const m = adapter.manifest.operations[operation];
  if (!m) throw new Error(`${provider} has no ${operation}`);
  const account = app.accounts.get(accountId);
  if (!account || account.provider !== provider) throw new Error(`account ${accountId} is not a connected ${provider} account`);
  const grant = app.accounts.grant(accountId);
  if (account.state !== "connected" || !grant || grant.state !== "active") throw new Error(`account ${accountId} has no active grant; connect it first`);
  const hours = Number(flag(rest, "--hours") ?? 24);
  const perDay = Number(flag(rest, "--per-day") ?? DEFAULT_PER_DAY);
  const total = Number(flag(rest, "--max-total") ?? DEFAULT_TOTAL);
  console.log(`\nStanding grant for ${provider} ${operation}`);
  console.log(`  account: ${account.display_name} (${accountId})`);
  console.log(`  While it is live, the MCP gateway may publish plain TEXT posts to this account WITHOUT asking you again for each post.`);
  console.log(`  Limits: ${perDay} per rolling 24 hours, ${total} in total, expires in ${hours} hour(s). Media, edits, deletes, replies and scheduled posts always need you.`);
  console.log("  An unresolved outcome suspends it. Revoke any time: xn-interact grant revoke <grant_id>. Posts are public and the gateway cannot delete them.");
  if (m.verdict !== "VERIFIED") console.log(`\n  NOTE: ${operation} is ${m.verdict} for ${provider}. A grant does not change that: until the operation is verified, plans are refused before any approval is looked at.`);
  const typedOp = prompt(`\nType the operation name (${operation}) to continue:`);
  if (typedOp?.trim() !== operation) throw new Error("not confirmed");
  const typedAccount = prompt(`Type the account name (${account.display_name}) to create the grant:`);
  if (typedAccount?.trim() !== account.display_name) throw new Error("not confirmed");
  const row = app.grants.create(provider, accountId, operation, { ttlMs: hours * 3600_000, maxPerDay: perDay, maxTotal: total }, { tty: true, user: userInfo().username });
  app.audit.record("human-cli", "grant.created", "created", { grant_id: row.id, provider, operation, expires_at: row.expires_at, max_per_day: row.max_per_day, max_total: row.max_total }, accountId);
  console.log(`\ncreated ${row.id}; expires ${row.expires_at}; ${row.max_per_day} per day, ${row.max_total} in total`);
  return 0;
}

async function evidenceCmd(app: App, sub: string | undefined, rest: string[]): Promise<number> {
  const USAGE_EVIDENCE = "usage: xn-interact evidence sign <provider> <operation> --account <account_id> [--days 90] | evidence list | evidence revoke <signoff_id>";
  if (sub === "list") {
    const rows = app.signoffs.list();
    if (!rows.length) console.log("no evidence signoffs");
    else console.log(JSON.stringify(rows.map((s) => publicSignoff(s)), null, 2));
    return 0;
  }
  if (sub === "revoke") {
    requireTty("revoking an evidence signoff");
    const id = rest[0];
    if (!id) throw new Error(USAGE_EVIDENCE);
    const ok = app.signoffs.revoke(id);
    if (ok) {
      app.audit.record("human-cli", "evidence.revoked", "revoked", { signoff_id: id });
      app.resolver.invalidate();
    }
    console.log(ok ? `revoked ${id}` : `nothing to revoke: ${id} is not an active signoff`);
    return ok ? 0 : 1;
  }
  if (sub !== "sign") throw new Error(USAGE_EVIDENCE);
  const [provider, operation] = rest;
  const accountId = flag(rest, "--account");
  if (!provider || !operation || !accountId) throw new Error(USAGE_EVIDENCE);
  requireTty("signing evidence");
  if (!SIGNABLE_OPERATIONS.has(operation)) throw new Error(`evidence can only be signed for: ${[...SIGNABLE_OPERATIONS].join(", ")}`);
  const adapter = app.providers.get(provider);
  if (adapter.testOnly && app.config.env !== "test") throw new Error(`${provider} is not a real provider`);
  const account = app.accounts.get(accountId);
  if (!account || account.provider !== provider) throw new Error(`account ${accountId} is not a connected ${provider} account`);
  const basis = app.signoffs.findBasis(accountId, operation);
  if (!basis) throw new Error(`no successful acceptance run of ${operation} on ${accountId} to rest on; run first-post first`);
  const days = Number(flag(rest, "--days") ?? 90);
  let url = "(not recorded)";
  try {
    url = app.engine.view(basis.run_id).targets.find((t) => t.url)?.url ?? url;
  } catch {}
  console.log(`\nSign evidence for ${provider} ${operation}`);
  console.log(`  account: ${account.display_name} (${accountId})`);
  console.log(`  basis: acceptance ${basis.acceptance_id} (spent ${basis.acceptance_consumed_at}), succeeded run ${basis.run_id}`);
  console.log(`  post: ${url}`);
  console.log(`  By signing you state this post really appeared and the operation works. It changes this operation on this account from UNVERIFIED to "runs after an approval or a live standing grant" for up to ${days} days.`);
  console.log("  It does NOT let anything publish without an approval or a standing grant. Revoke any time: xn-interact evidence revoke <signoff_id>.");
  const typedOp = prompt(`\nType the operation name (${operation}) to continue:`);
  if (typedOp?.trim() !== operation) throw new Error("not confirmed");
  const typedAccount = prompt(`Type the account name (${account.display_name}) to sign:`);
  if (typedAccount?.trim() !== account.display_name) throw new Error("not confirmed");
  const row = app.signoffs.sign(provider, accountId, operation, { days }, { tty: true, user: userInfo().username });
  app.audit.record("human-cli", "evidence.signed", "signed", { signoff_id: row.id, provider, operation, basis_run_id: row.basis_run_id, expires_at: row.expires_at }, accountId);
  app.resolver.invalidate(accountId);
  console.log(`\nsigned ${row.id}; expires ${row.expires_at}`);
  return 0;
}

/** The owner's terminal may name any file; it is copied into the first media root when it is not already inside one. */
async function stageForOwner(app: App, file: string): Promise<{ media_id: string; sha256: string; mime: string }> {
  const abs = resolve(file);
  let up = await invoke(app, "social_media_upload", { path: abs });
  if (!up.ok && up.error?.code === "PROHIBITED" && /outside the configured media roots/.test(String(up.error.message))) {
    const dest = join(app.config.mediaRoots[0] ?? join(app.config.home, "inbox"), basename(abs));
    copyFileSync(abs, dest);
    up = await invoke(app, "social_media_upload", { path: dest });
  }
  if (!up.ok) throw new Error(`could not stage ${file}: ${up.error?.code} ${up.error?.message}`);
  return up.data as { media_id: string; sha256: string; mime: string };
}

async function mediaCmd(app: App, sub: string | undefined, rest: string[]): Promise<number> {
  const USAGE_MEDIA = "usage: xn-interact media url <jpeg> | media host <jpeg>";
  const file = rest[0];
  if ((sub !== "url" && sub !== "host") || !file) throw new Error(USAGE_MEDIA);
  const base = app.config.publicMediaBase;
  if (!base) throw new Error("set XN_INTERACT_PUBLIC_MEDIA_BASE to the HTTPS directory where approved JPEGs are hosted");
  const media = await stageForOwner(app, file);
  if (media.mime !== "image/jpeg") throw new Error(`Instagram only accepts JPEG; ${file} is ${media.mime}`);
  const name = `${media.sha256}.jpg`;
  const publicUrl = `${base}${name}`;
  if (sub === "url") {
    console.log(JSON.stringify({ sha256: media.sha256, host_as: name, public_url: publicUrl }, null, 2));
    return 0;
  }
  requireTty("hosting media publicly");
  const dir = app.config.publicMediaDir;
  if (!dir) throw new Error("set XN_INTERACT_PUBLIC_MEDIA_DIR to a local git checkout that is served at XN_INTERACT_PUBLIC_MEDIA_BASE");
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is not a git checkout`);
  console.log(`\nThis copies ${file} into ${dir} as ${name}, commits it and pushes it.`);
  console.log(`  Afterwards ANYONE can fetch it at ${publicUrl}. XN-Interact cannot undo that: remove it from the repository yourself.`);
  const typed = prompt(`\nType the first 8 characters of the sha256 (${media.sha256.slice(0, 8)}) to publish this file publicly:`);
  if (typed?.trim() !== media.sha256.slice(0, 8)) throw new Error("not confirmed");
  hostPublicly(dir, join(app.config.mediaDir, name), name, `media ${media.sha256.slice(0, 8)}`);
  app.audit.record("human-cli", "media.hosted", "hosted", { sha256: media.sha256, public_url: publicUrl });
  console.log(`\nhosted: ${publicUrl}`);
  return 0;
}

async function firstPostCmd(app: App, provider: string | undefined, rest: string[]): Promise<number> {
  requireTty("publishing a test post");
  const file = flag(rest, "--text-file");
  const imageFile = flag(rest, "--image-file");
  if (!provider || !file) throw new Error("usage: xn-interact first-post <provider> --text-file <file> [--image-file <jpeg>] [--account <id>]");
  const operation = imageFile ? "content.publish.image" : "content.publish.text";
  const text = (await Bun.file(file).text()).replace(/\s+$/, "");
  if (!text) throw new Error(`${file} is empty`);
  const connected = app.accounts.list({ provider }).filter((a) => a.state === "connected");
  const accountId = flag(rest, "--account") ?? (connected.length === 1 ? connected[0]!.id : undefined);
  if (!accountId) throw new Error(`pass --account; connected ${provider} accounts: ${connected.map((a) => `${a.id} (${a.display_name})`).join(", ") || "none"}`);
  const account = app.accounts.get(accountId);
  let mediaIds: string[] = [];
  let imageInfo = "";
  if (imageFile) {
    const base = app.config.publicMediaBase;
    if (provider === "instagram" && !base) throw new Error("Instagram image posts need XN_INTERACT_PUBLIC_MEDIA_BASE (the HTTPS directory where you host approved JPEGs)");
    const media = await stageForOwner(app, imageFile);
    mediaIds = [media.media_id];
    imageInfo = `${media.mime}, sha256 ${media.sha256}`;
    if (provider === "instagram" && base) {
      const publicUrl = `${base}${media.sha256}.jpg`;
      imageInfo += `\n  Instagram fetches the image from ${publicUrl}`;
      const head = await app.http.request("instagram", { method: "HEAD", url: publicUrl, safe: true }).catch(() => null);
      if (head?.status !== 200) throw new Error(`the image is not served at ${publicUrl} yet; host it first: xn-interact media host ${imageFile}`);
    }
  }
  console.log(`\nThis publishes the ${imageFile ? "caption and image" : "text"} below PUBLICLY to ${provider} as ${account?.display_name ?? accountId}.`);
  console.log("The gateway has no delete permission: remove the post yourself in the provider app if it was only a test.\n");
  if (imageFile) console.log(`  image: ${imageInfo}\n`);
  console.log(text.split("\n").map((l) => `  | ${l}`).join("\n"));
  const needed = [operation, ...(app.providers.get(provider).manifest.operations[operation]?.acceptance_with ?? [])];
  if (!needed.every((op) => app.acceptance.armed(accountId, op))) {
    const armed = await acceptCmd(app, provider, [operation, "--account", accountId]);
    if (armed !== 0) return armed;
  }
  const draft = await invoke(app, "social_content_create", { text, media_ids: mediaIds });
  if (!draft.ok) throw new Error(`draft failed: ${draft.error?.code} ${draft.error?.message}`);
  const plan = await invoke(app, "social_content_publish", { mode: "plan", account_ids: [accountId], draft_id: (draft.data as { draft_id: string }).draft_id });
  if (!plan.ok) throw new Error(`plan failed: ${plan.error?.code} ${plan.error?.message}`);
  const d = plan.data as { plan_id: string; approval: { approval_id: string } };
  await decide(app, d.approval.approval_id, "approved");
  console.log("\nPublishing...");
  const exec = await invoke(app, "social_content_publish", { mode: "execute", plan_id: d.plan_id, operation_id: `op-first-post-${Date.now()}` });
  console.log(JSON.stringify({ ok: exec.ok, data: exec.data ?? null, error: exec.error ?? null }, null, 2));
  return exec.ok ? 0 : 1;
}

async function decide(app: App, id: string, decision: "approved" | "rejected"): Promise<void> {
  requireTty(decision === "approved" ? "approval" : "rejection");
  const a = app.approvals.get(id);
  const plan = app.plans.get(a.plan_id);
  const p = plan.payload;
  console.log(`\nApproval ${a.id} — ${p.operation} via ${p.tool}${p.skill ? ` (skill ${p.skill})` : ""}`);
  console.log(`Plan ${plan.id}, hash ${plan.plan_hash}`);
  console.log(`Expires ${a.expires_at}${p.schedule_at ? `, scheduled for ${p.schedule_at}` : ""}`);
  for (const t of p.targets) {
    const acc = app.accounts.get(t.account_id);
    console.log(`\n  → ${t.provider} ${acc?.display_name ?? ""} (${t.account_id}) ${t.operation}`);
    if (t.preview) console.log(`    text (${t.preview.chars}${t.preview.limit ? `/${t.preview.limit}` : ""} chars):\n    ${t.preview.text.split("\n").join("\n    ")}`);
    const media = (t.params.media as { kind: string; mime: string; sha256: string }[] | undefined) ?? [];
    for (const m of media) console.log(`    media: ${m.kind} ${m.mime} sha256 ${m.sha256.slice(0, 16)}…`);
    for (const [k, v] of Object.entries(t.params)) if (!["text", "media", "title", "link"].includes(k) && v !== undefined && v !== null) console.log(`    ${k}: ${JSON.stringify(v)}`);
  }
  for (const x of p.excluded) console.log(`\n  ✗ excluded ${x.account_id}: ${x.state} — ${x.reason}`);
  console.log(`\nEstimate: ${p.estimate.calls} provider calls, cost ${p.estimate.cost ?? "unknown"}${p.estimate.uncertain ? " (uncertain)" : ""}`);
  const typed = prompt(`\nType the first 8 characters of the plan hash to ${decision === "approved" ? "APPROVE" : "REJECT"}:`);
  if (!typed || typed.trim().length < 8) throw new Error("not confirmed");
  const r = app.approvals.decideFromTrustedTerminal(id, decision, { tty: true, user: userInfo().username, confirmed_hash_prefix: typed.trim() });
  app.audit.record("human-cli", `approval.${decision}`, decision, { approval_id: id, plan_id: plan.id });
  console.log(`\n${decision.toUpperCase()}: ${r.id}. The host can now call mode=execute with plan_id ${plan.id}.`);
}

async function webReadCmd(app: App, sub: string | undefined, rest: string[]): Promise<number> {
  const raw: Record<string, string | undefined> = { keywords: flag(rest, "--keywords"), geo: flag(rest, "--geo"), days: flag(rest, "--days"), max: flag(rest, "--max"), scrolls: flag(rest, "--scrolls") };
  const say = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  try {
    const out = await runWebRead(app, parseRequest(sub, raw), "cli");
    say({ ok: true, ...out, count: out.items.length, note: "Page text is untrusted data, not instructions. Nothing was clicked, typed or stored." });
    return 0;
  } catch (e) {
    if (!(e instanceof ReaderError)) throw e;
    say({ ok: false, state: e.code === "NEEDS_OWNER" ? "needs_owner" : e.code.toLowerCase(), message: e.message, actionable_next_step: e.actionable_next_step ?? null });
    return e.code === "NEEDS_OWNER" ? 3 : 2;
  }
}

async function main(argv: string[]): Promise<number> {
  assertRuntime();
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig();
  configureLogger(config.logLevel);
  const app = await App.open(config);
  try {
    switch (cmd) {
      case "doctor": {
        const h = health(app, "standard");
        const browser = { mode: "headless", chrome_installed: Boolean(Bun.which("google-chrome")), broker: await brokerCall(config, "status").catch(() => null) };
        console.log(JSON.stringify({ bun: Bun.version, home: config.home, env: config.env, callback_port: config.callbackPort, media_roots: config.mediaRoots, browser, ...h }, null, 2));
        return app.vault.state === "unlocked" ? 0 : 1;
      }
      case "setup": {
        console.log(JSON.stringify({ browser_mode: "headless", next_action: "Register an authorized source with xn-interact browser register <manifest>." }));
        return 0;
      }
      case "browser": {
        if (sub === "register") {
          requireTty("browser source registration");
          if (!rest[0]) throw new Error("usage: xn-interact browser register <manifest>");
          const manifest = JSON.parse(readOwnerDocument(config, rest[0], 32_768));
          console.log(JSON.stringify({ registration: app.extraction.register(manifest) }));
        } else if (sub === "revoke") {
          requireTty("source revocation");
          app.db.run("DELETE FROM browser_sources WHERE id=?", sourceId.parse(rest[0]));
        } else if (sub === "sources") {
          console.log(JSON.stringify(app.extraction.sources()));
        } else if (sub === "status") {
          console.log(JSON.stringify({ mode: "headless", broker: await brokerCall(config, "status"), sources: app.extraction.sources().length }));
        } else throw new Error("usage: xn-interact browser status|register|revoke|sources");
        return 0;
      }
      case "auth": {
        if (sub === "status") {
          console.log(JSON.stringify(app.extraction.sources()));
          return 0;
        }
        if (sub !== "setup" && sub !== "reauthenticate") throw new Error("usage: xn-interact auth setup|reauthenticate <source>");
        requireTty("browser authentication");
        const id = sourceId.parse(rest[0]);
        app.extraction.source(id);
        const broker = await brokerCall(config, "status");
        if (broker?.active_run || app.extraction.next()) throw new Error("finish or cancel pending collections before interactive authentication");
        if (broker) await stopBrowserBroker();
        const browser = Bun.spawn(brokerCommand(config, ["authenticate", id]), { env: brokerEnv(config), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        return await browser.exited;
      }
      case "broker": {
        if (sub === "stop" || sub === "restart") await stopBrowserBroker();
        const status = sub === "start" || sub === "restart" ? await ensureBroker(config) : await brokerCall(config, "status");
        if (!["start", "stop", "restart", "status"].includes(sub ?? "")) throw new Error("usage: xn-interact broker start|stop|restart|status");
        console.log(JSON.stringify({ broker: status }));
        return 0;
      }
      case "extract": {
        if (sub !== "resume") throw new Error("usage: xn-interact extract resume <run-id>");
        const run = app.extraction.resume(extractionRunId.parse(rest[0]));
        if (run.status === "queued" || run.status === "running") await ensureBroker(config);
        console.log(JSON.stringify(run));
        return 0;
      }
      case "datasets": {
        requireTty("dataset administration");
        if (sub === "register" && rest[0]) {
          const manifest = JSON.parse(readOwnerDocument(config, rest[0], 32_768));
          console.log(JSON.stringify({ registration: app.extraction.registerOwnerExport(manifest) }));
        } else if (sub === "ingest" && rest[0] && rest[1]) {
          const manifest = JSON.parse(readOwnerDocument(config, rest[0], 32_768));
          console.log(JSON.stringify(ingestOwnerExport(config, app.extraction, rest[1], manifest)));
        } else if (sub === "delete") {
          console.log(JSON.stringify(deleteDataset(config, app.extraction, extractionRunId.parse(rest[0]))));
        } else throw new Error("usage: xn-interact datasets register <source-manifest> | ingest <manifest> <file> | delete <dataset-ref>");
        return 0;
      }
      case "vault": {
        if (sub === "init") {
          const r = await app.vault.init();
          console.log(r.created ? `vault key v${r.version} created in the ${app.vault.backend} keyring` : `vault already initialized (key v${r.version})`);
          return 0;
        }
        if (sub === "rotate") {
          console.log(`new key version ${await app.vault.rotate()}; existing ciphertexts stay readable with their key version`);
          return 0;
        }
        console.log(JSON.stringify({ state: app.vault.state, backend: app.vault.backend, reason: app.vault.reason, key_version: app.vault.keyVersion }));
        return app.vault.state === "unlocked" ? 0 : 1;
      }
      case "app": {
        if (sub !== "set" || !rest[0]) throw new Error("usage: xn-interact app set <provider>");
        await storeApp(app, rest[0], rest);
        return 0;
      }
      case "login": {
        if (!sub) throw new Error("usage: xn-interact login <provider> [--open] [--https|--loopback] [--reset]");
        const adapter = app.providers.get(sub);
        if (adapter.testOnly && config.env !== "test") throw new Error(`${sub} is not a real provider`);
        const registered = app.apps.registered(sub) && !rest.includes("--reset");
        const mode = rest.includes("--https") ? "https" : rest.includes("--loopback") ? "loopback" : config.redirectMode === "auto" ? (adapter.oauth.redirect ?? "loopback") : config.redirectMode;
        const redirectUri = mode === "https" ? `https://127.0.0.1:${config.httpsPort}${adapter.oauth.callback_path}` : `http://127.0.0.1:${config.callbackPort}${adapter.oauth.callback_path}`;
        if (!registered) {
          requireTty("entering the app credentials");
          console.log(`\n${sub}: no app credentials stored yet.`);
          console.log(`1. Create the app here: ${CONSOLES[sub] ?? "(see docs/login.md)"}`);
          console.log(`2. Register this redirect URI exactly: ${redirectUri}`);
          console.log(`3. Copy the app id and secret, then paste them below (hidden, stored only in the OS keyring).`);
          if (adapter.oauth.caveat) console.log(`note: ${adapter.oauth.caveat}`);
          if (rest.includes("--open") && CONSOLES[sub]) Bun.spawn(["xdg-open", CONSOLES[sub]!], { stdout: "ignore", stderr: "ignore" });
          console.log("");
          await storeApp(app, sub, rest);
        } else {
          console.log(`${sub}: app credentials already stored (use --reset to replace them).`);
        }
        return await runConnect(app, sub, rest);
      }
      case "first-post": {
        return await firstPostCmd(app, sub, rest);
      }
      case "accept": {
        return await acceptCmd(app, sub, rest);
      }
      case "grant": {
        return await grantCmd(app, sub, rest);
      }
      case "evidence": {
        return await evidenceCmd(app, sub, rest);
      }
      case "media": {
        return await mediaCmd(app, sub, rest);
      }
      case "providers": {
        const rows = app.providers.ids().filter((id) => !app.providers.get(id).testOnly).map((id) => {
          const a = app.providers.get(id);
          const mode = config.redirectMode === "auto" ? (a.oauth.redirect ?? "loopback") : config.redirectMode;
          const redirect = mode === "https" ? `https://127.0.0.1:${config.httpsPort}${a.oauth.callback_path}` : `http://127.0.0.1:${config.callbackPort}${a.oauth.callback_path}`;
          return { id, login: a.oauth.verified ? "ready" : "unverified", app: app.apps.registered(id) ? "registered" : "missing", accounts: app.accounts.list({ provider: id, state: "connected" }).length, redirect, scopes: (a.manifest.login_scopes ?? []).join(","), note: a.oauth.caveat ?? "" };
        });
        for (const r of rows) {
          console.log(`${r.id.padEnd(10)} login=${r.login}  app=${r.app}  accounts=${r.accounts}`);
          console.log(`           register this redirect URI: ${r.redirect}`);
          console.log(`           scopes: ${r.scopes}`);
          if (r.note) console.log(`           note: ${r.note}`);
        }
        return 0;
      }
      case "connect": {
        if (!sub) throw new Error("usage: xn-interact connect <provider> [--open]");
        return await runConnect(app, sub, rest);
      }
      case "web-read": {
        return await webReadCmd(app, sub, rest);
      }
      case "approvals":
        console.log(JSON.stringify(app.approvals.pending().map(publicApproval), null, 2));
        return 0;
      case "approve":
      case "reject":
        if (!sub) throw new Error(`usage: xn-interact ${cmd} <approval_id>`);
        await decide(app, sub, cmd === "approve" ? "approved" : "rejected");
        return 0;
      case "budget": {
        if (sub === "show") {
          console.log(JSON.stringify(app.budget.snapshot(), null, 2));
          return 0;
        }
        if (sub !== "set" || !rest[0] || !rest[1]) throw new Error("usage: xn-interact budget set <account_id> <operation|*> [--max-calls N] [--max-cost X]");
        const calls = flag(rest, "--max-calls");
        const cost = flag(rest, "--max-cost");
        app.budget.setLimit(rest[0], rest[1], calls ? Number(calls) : null, cost ? Number(cost) : null);
        app.resolver.invalidate(rest[0]);
        console.log("budget saved");
        return 0;
      }
      case "recover": {
        const r = app.engine.recover();
        console.log(JSON.stringify({ ...r, reconcile: await app.engine.recoverUnknown() }, null, 2));
        return 0;
      }
      case "worker": {
        app.startTicker();
        console.log(`worker running (tick ${config.tickMs} ms, vault ${app.vault.state}, home ${config.home}); Ctrl-C to stop`);
        onShutdown(() => app.close());
        await new Promise(() => {});
        return 0;
      }
      case "retention": {
        if (sub !== "run") throw new Error("usage: xn-interact retention run");
        const n = (flagName: string, dflt: number) => Number(flag(rest, flagName) ?? dflt);
        const policy = { audit_days: n("--audit-days", DEFAULT_RETENTION.audit_days), terminal_run_days: n("--run-days", DEFAULT_RETENTION.terminal_run_days), plan_days: n("--plan-days", DEFAULT_RETENTION.plan_days) };
        console.log(JSON.stringify({ policy, deleted: purge(app.db, config.mediaDir, policy) }, null, 2));
        return 0;
      }
      case "backup": {
        if (sub === "verify") {
          if (!rest[0]) throw new Error("usage: xn-interact backup verify <file>");
          const v = verifyBackup(rest[0]);
          console.log(JSON.stringify(v));
          return v.ok ? 0 : 1;
        }
        if (!sub) throw new Error("usage: xn-interact backup <file>");
        console.log(JSON.stringify(backup(app.db, sub)));
        return 0;
      }
      case "audit":
        console.log(app.audit.exportScrubbed());
        return 0;
      default:
        console.log(USAGE);
        return 2;
    }
  } finally {
    if (cmd !== "worker") app.close();
  }

  async function stopBrowserBroker() {
    await brokerCall(config, "stop");
    const deadline = Date.now() + 35_000;
    while (await brokerCall(config, "status")) {
      if (Date.now() >= deadline) throw new Error("browser broker is still shutting down");
      await Bun.sleep(100);
    }
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof GatewayError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
