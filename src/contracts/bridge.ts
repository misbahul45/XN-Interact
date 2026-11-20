import bridgeDoc from "../../plan/bridge.json" with { type: "json" };
import { CATALOG } from "./catalog.ts";

interface OutcomeRow {
  run_state: string;
  outcome: string;
  error_class: string;
}

const MAP = new Map((bridgeDoc as unknown as { outcome_map: OutcomeRow[] }).outcome_map.map((o) => [o.run_state, o]));

export function bridgeOutcome(runState: string, firstErrorCode?: string | null): { outcome: string; error_class: string; partial?: boolean } | undefined {
  const row = MAP.get(runState);
  if (!row) return undefined;
  let cls = row.error_class;
  if (cls === "FROM_ERROR_CODE") cls = CATALOG.error_codes.find((e) => e.code === firstErrorCode)?.bridge_error_class ?? "TOOL_ERROR";
  return runState === "partially_succeeded" ? { outcome: row.outcome, error_class: cls, partial: true } : { outcome: row.outcome, error_class: cls };
}
