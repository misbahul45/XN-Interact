import providersDoc from "../../plan/providers.json" with { type: "json" };
import { CATALOG } from "../contracts/catalog.ts";
import { GatewayError } from "../contracts/errors.ts";
import type { AdapterManifest, OAuthProfile, OperationManifest, ProviderAdapter, Verdict } from "./contract.ts";

interface Row {
  provider: string;
  evidence_task: string;
  spec_reference_urls: string[];
  spec_concern: string;
  operations: Record<string, string>;
  verified_date: string | null;
}

export const PROVIDER_OPERATIONS = CATALOG.operations.filter((o) => o.scope === "provider").map((o) => o.id);

export function evidenceRow(provider: string): Row | undefined {
  return (providersDoc as unknown as { rows: Row[] }).rows.find((r) => r.provider === provider);
}

export function manifestFromEvidence(provider: string): AdapterManifest {
  const row = evidenceRow(provider);
  const operations: Record<string, OperationManifest> = {};
  for (const op of PROVIDER_OPERATIONS) {
    const verdict = (row?.operations[op] ?? "UNVERIFIED") as Verdict;
    operations[op] = {
      verdict: verdict === "VERIFIED" ? "UNVERIFIED" : verdict,
      scopes: [],
      account_types: [],
      read_after_write: false,
      reason: verdict === "VERIFIED" ? "evidence verified but no adapter implementation yet" : `Stage-0 evidence for ${provider} is not signed (${row?.evidence_task ?? "no task"})`,
    };
  }
  return { provider, adapter_version: "0.0.0", api_version: null, hosts: [], evidence_verified: false, docs_urls: row?.spec_reference_urls ?? [], operations };
}

export class UnverifiedAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest;
  readonly oauth: OAuthProfile = { verified: false, authorize_url: null, token_url: null, revoke_url: null, pkce: "S256", scope_separator: " ", callback_path: "" };

  constructor(readonly provider: string) {
    this.manifest = manifestFromEvidence(provider);
    this.oauth.callback_path = `/oauth/callback/${provider}`;
  }

  private refuse(): never {
    const row = evidenceRow(this.provider);
    throw new GatewayError("UNVERIFIED", `${this.provider} is not verified: official evidence row ${row?.evidence_task ?? "?"} is unsigned, so no request is sent`, {
      provider: this.provider,
      actionable_next_step: `Complete and sign the ${this.provider} Stage-0 evidence row (${row?.evidence_task}); then implement its adapter (P8)`,
    });
  }

  authorizeUrl(): string {
    return this.refuse();
  }
  exchangeCode(): never {
    return this.refuse();
  }
  refresh(): never {
    return this.refuse();
  }
  revoke(): never {
    return this.refuse();
  }
  identities(): never {
    return this.refuse();
  }
  read(): never {
    return this.refuse();
  }
  write(): never {
    return this.refuse();
  }
  inspectWriteOutcome(): never {
    return this.refuse();
  }
}
