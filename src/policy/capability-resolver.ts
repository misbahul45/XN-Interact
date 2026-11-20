import { CATALOG, operation as catalogOp } from "../contracts/catalog.ts";
import type { AccountRegistry, AccountRow } from "../identity/account-registry.ts";
import type { AppSecrets } from "../identity/app-secrets.ts";
import type { OperationManifest } from "../providers/contract.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { type Db, jsonOr } from "../storage/db.ts";
import type { Acceptance } from "./acceptance.ts";
import type { Signoffs } from "./signoffs.ts";
import type { Budget } from "./budget.ts";
import { type EvidenceLookup, defaultEvidenceLookup, evidenceIsFresh } from "./evidence-freshness.ts";

export type CapabilityState =
  | "AVAILABLE" | "NOT_CONNECTED" | "MISSING_SCOPES" | "APP_APPROVAL_REQUIRED" | "ACCOUNT_TYPE_UNSUPPORTED" | "ACCOUNT_ROLE_INSUFFICIENT"
  | "RATE_LIMITED" | "COST_LIMITED" | "NEEDS_APPROVAL" | "MANUAL_ONLY" | "PROHIBITED" | "UNVERIFIED" | "UNSUPPORTED" | "PROVIDER_UNAVAILABLE";

export interface CapabilityVerdict {
  operation: string;
  state: CapabilityState;
  reason: string;
  requires_approval: boolean;
  missing_scopes?: string[];
  retry_after_ms?: number;
  estimated_cost?: number | null;
  cost_uncertain?: boolean;
  acceptance?: boolean;
  limits?: OperationManifest["limits"];
  manual_url?: string;
}

const CACHE_TTL_MS = 3600_000;

class Circuit {
  private failures = new Map<string, number[]>();
  private openUntil = new Map<string, number>();
  fail(provider: string): void {
    const now = Date.now();
    const recent = (this.failures.get(provider) ?? []).filter((t) => now - t < 300_000);
    recent.push(now);
    this.failures.set(provider, recent);
    if (recent.length >= 3) this.openUntil.set(provider, now + 60_000);
  }
  ok(provider: string): void {
    this.failures.delete(provider);
    this.openUntil.delete(provider);
  }
  open(provider: string): boolean {
    return (this.openUntil.get(provider) ?? 0) > Date.now();
  }
}

export class CapabilityResolver {
  readonly circuit = new Circuit();

  constructor(
    private readonly db: Db,
    private readonly providers: ProviderRegistry,
    private readonly accounts: AccountRegistry,
    private readonly apps: AppSecrets,
    private readonly budget: Budget,
    private readonly evidence: EvidenceLookup = defaultEvidenceLookup,
    private readonly clock: () => number = Date.now,
    private readonly acceptance: Acceptance | null = null,
    private readonly signoffs: Signoffs | null = null,
  ) {}

  private evidenceFresh(provider: string): boolean {
    const adapter = this.providers.get(provider);
    if (adapter.testOnly) return true;
    return evidenceIsFresh(this.evidence(provider)?.verified_date, this.clock());
  }

  cacheKey(account: AccountRow): string {
    const adapter = this.providers.get(account.provider);
    const grant = this.accounts.grant(account.id);
    const manifestDigest = new Bun.CryptoHasher("sha256").update(JSON.stringify(adapter.manifest.operations)).digest("hex").slice(0, 16);
    const parts = [this.evidenceFresh(account.provider) ? "fresh" : "stale", account.provider, adapter.manifest.api_version, adapter.manifest.adapter_version, manifestDigest, this.apps.products(account.provider).join(","), this.apps.policyEpoch(account.provider), account.account_type, account.role, account.state, grant?.revision ?? 0, grant?.state ?? "none", this.acceptance?.epoch(account.id) ?? "0", this.signoffs?.epoch(account.id) ?? "0", CATALOG.version];
    return new Bun.CryptoHasher("sha256").update(parts.join("|")).digest("hex");
  }

  private staticVerdict(account: AccountRow, op: string): CapabilityVerdict {
    const def = catalogOp(op);
    const needsApproval = def.risk === "EXTERNAL_WRITE";
    const base = { operation: op, requires_approval: needsApproval };
    if (def.scope === "local") return { ...base, state: "AVAILABLE", reason: "local operation" };
    if (op === "auth.revoke") {
      const g = this.accounts.grant(account.id);
      if (account.state === "revoked" || !g || g.state === "revoked") return { ...base, state: "NOT_CONNECTED", reason: "no active grant" };
      return { ...base, state: "NEEDS_APPROVAL", reason: "erasing the local grant is always allowed; provider-side revocation is best effort" };
    }
    const adapter = this.providers.get(account.provider);
    const m = adapter.manifest.operations[op];
    if (!m) return { ...base, state: "UNSUPPORTED", reason: `${account.provider} adapter has no ${op}` };
    const accepted = m.verdict === "UNVERIFIED" && m.acceptance === true && Boolean(this.acceptance?.armed(account.id, op));
    const signed = m.verdict === "UNVERIFIED" && m.acceptance === true && Boolean(this.signoffs?.active(account.id, op));
    if (m.verdict !== "VERIFIED" && !accepted && !signed) return { ...base, state: m.verdict, reason: m.reason ?? `${op} is ${m.verdict} for ${account.provider}`, manual_url: m.manual_url };
    if (!this.evidenceFresh(account.provider)) {
      return { ...base, state: "UNVERIFIED", reason: `Stage-0 evidence for ${account.provider} is missing or older than 90 days; re-verify it against the official documentation` };
    }
    const grant = this.accounts.grant(account.id);
    if (account.state === "revoked" || !grant || grant.state === "revoked") return { ...base, state: "NOT_CONNECTED", reason: "no active grant" };
    if (account.state === "needs_reauth" || grant.state === "refresh_failed") return { ...base, state: "NOT_CONNECTED", reason: "grant must be reauthorized" };
    if (m.account_types.length && !m.account_types.includes(account.account_type)) return { ...base, state: "ACCOUNT_TYPE_UNSUPPORTED", reason: `${op} needs account type ${m.account_types.join(" or ")}` };
    if (m.roles?.length && !m.roles.includes(account.role ?? "")) return { ...base, state: "ACCOUNT_ROLE_INSUFFICIENT", reason: `${op} needs role ${m.roles.join(" or ")}` };
    const products = this.apps.products(account.provider);
    const missingProducts = (m.products ?? []).filter((p) => !products.includes(p) && !products.includes("*"));
    if (missingProducts.length) return { ...base, state: "APP_APPROVAL_REQUIRED", reason: `operator app lacks approved products ${missingProducts.join(", ")}` };
    const scopes = jsonOr<string[]>(grant.scopes_json, []);
    const missing = m.scopes.filter((s) => !scopes.includes(s));
    if (missing.length) return { ...base, state: "MISSING_SCOPES", reason: "grant lacks scopes", missing_scopes: missing };
    const reason = accepted ? "one owner-armed acceptance run: this operation is not verified yet and runs once, after the usual approval" : signed ? "owner-signed evidence from a real acceptance run: runs after a trusted human approval or a live standing grant" : needsApproval ? "available after a trusted human approval" : "available";
    return { ...base, state: needsApproval ? "NEEDS_APPROVAL" : "AVAILABLE", reason, limits: m.limits, ...(accepted ? { acceptance: true } : {}) };
  }

  private cached(account: AccountRow, force: boolean): Map<string, CapabilityVerdict> {
    const key = this.cacheKey(account);
    if (force) this.db.run("DELETE FROM capability_snapshots WHERE account_id = ?", account.id);
    const hit = this.db.get<{ payload_json: string; expires_at: string }>("SELECT payload_json, expires_at FROM capability_snapshots WHERE account_id = ? AND cache_key = ?", account.id, key);
    if (hit && Date.parse(hit.expires_at) > Date.now()) return new Map(Object.entries(jsonOr<Record<string, CapabilityVerdict>>(hit.payload_json, {})));
    const out = new Map<string, CapabilityVerdict>();
    for (const op of CATALOG.operations) out.set(op.id, this.staticVerdict(account, op.id));
    const payload = JSON.stringify(Object.fromEntries(out));
    this.db.tx(() => {
      this.db.run("DELETE FROM capability_snapshots WHERE account_id = ?", account.id);
      this.db.run("INSERT INTO capability_snapshots(account_id, cache_key, digest, payload_json, expires_at) VALUES (?, ?, ?, ?, ?)", account.id, key,
        new Bun.CryptoHasher("sha256").update(payload).digest("hex"), payload, new Date(Date.now() + CACHE_TTL_MS).toISOString());
    });
    return out;
  }

  resolve(accountId: string, op: string, opts: { force?: boolean; approved?: boolean } = {}): CapabilityVerdict {
    const account = this.accounts.get(accountId);
    if (!account) return { operation: op, state: "NOT_CONNECTED", reason: `account ${accountId} is not connected`, requires_approval: catalogOp(op).risk === "EXTERNAL_WRITE" };
    return this.dynamic(account, this.cached(account, Boolean(opts.force)).get(op) ?? this.staticVerdict(account, op), opts.approved ?? false);
  }

  all(accountId: string, opts: { force?: boolean; prefix?: string } = {}): CapabilityVerdict[] {
    const account = this.accounts.require(accountId);
    const snap = this.cached(account, Boolean(opts.force));
    return [...snap.values()].filter((v) => !opts.prefix || v.operation.startsWith(opts.prefix)).map((v) => this.dynamic(account, v, false));
  }

  private dynamic(account: AccountRow, v: CapabilityVerdict, approved: boolean): CapabilityVerdict {
    if (v.state !== "AVAILABLE" && v.state !== "NEEDS_APPROVAL") return v;
    const def = catalogOp(v.operation);
    if (def.scope === "local") return v;
    if (this.circuit.open(account.provider)) return { ...v, state: "PROVIDER_UNAVAILABLE", reason: "provider circuit open after repeated failures" };
    const m = this.providers.get(account.provider).manifest.operations[v.operation]!;
    const a = this.budget.admit(account.id, v.operation, m);
    if (a.state !== "AVAILABLE") return { ...v, state: a.state, reason: a.reason ?? a.state, retry_after_ms: a.retry_after_ms, estimated_cost: a.estimated_cost, cost_uncertain: a.cost_uncertain };
    const out = { ...v, estimated_cost: a.estimated_cost, cost_uncertain: a.cost_uncertain };
    if (v.state === "NEEDS_APPROVAL" && approved) return { ...out, state: "AVAILABLE", reason: "approved" };
    return out;
  }

  invalidate(accountId?: string): void {
    if (accountId) this.db.run("DELETE FROM capability_snapshots WHERE account_id = ?", accountId);
    else this.db.run("DELETE FROM capability_snapshots");
  }

}
