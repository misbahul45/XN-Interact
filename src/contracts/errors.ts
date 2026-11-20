import { CATALOG } from "./catalog.ts";

export type ErrorCode =
  | "VALIDATION_FAILED" | "ACCOUNT_REQUIRED" | "AMBIGUOUS_SKILL" | "RESULT_REF_EXPIRED" | "NOT_CONNECTED" | "MISSING_SCOPES"
  | "REAUTH_REQUIRED" | "ACCOUNT_ROLE_INSUFFICIENT" | "VAULT_LOCKED" | "APP_APPROVAL_REQUIRED" | "PROHIBITED" | "MANUAL_ONLY"
  | "ACCOUNT_TYPE_UNSUPPORTED" | "UNVERIFIED" | "UNSUPPORTED" | "RATE_LIMITED" | "COST_LIMITED" | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID" | "PLAN_CHANGED" | "IDEMPOTENCY_CONFLICT" | "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR"
  | "INVALID_PROVIDER_RESPONSE" | "OUTCOME_UNKNOWN" | "INTERNAL_ERROR";

export interface ErrorExtras {
  missing_scopes?: string[];
  retry_after_ms?: number;
  actionable_next_step?: string;
  provider?: string;
  provider_status?: number;
  approval_id?: string;
  detail?: Record<string, unknown>;
}

export interface ErrorBody extends ErrorExtras {
  code: ErrorCode;
  category: string;
  retryable: boolean;
  bridge_error_class: string;
  message: string;
}

const BY_CODE = new Map(CATALOG.error_codes.map((e) => [e.code, e]));

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly extras: ErrorExtras;

  constructor(code: ErrorCode, message: string, extras: ErrorExtras = {}) {
    super(message);
    if (!BY_CODE.has(code)) throw new Error(`error code ${code} is not in the catalog`);
    this.name = "GatewayError";
    this.code = code;
    this.extras = extras;
  }

  body(): ErrorBody {
    const def = BY_CODE.get(this.code)!;
    return { code: this.code, category: def.category, retryable: def.retryable, bridge_error_class: def.bridge_error_class, message: this.message, ...this.extras };
  }
}

export function errorForCapabilityState(state: string): ErrorCode | null {
  if (state === "AVAILABLE") return null;
  const def = CATALOG.error_codes.find((e) => e.capability_state === state);
  return (def?.code as ErrorCode | undefined) ?? "UNSUPPORTED";
}

export function toGatewayError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e;
  return new GatewayError("INTERNAL_ERROR", "internal error; see the local audit log");
}
