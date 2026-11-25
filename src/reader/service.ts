import type { App } from "../app.ts";
import { GatewayError } from "../contracts/errors.ts";
import { type ReadOutcome, readWeb } from "./web-reader.ts";
import { MIN_SECONDS_BETWEEN_RUNS, parseReaderCdp, ReaderError, type ReadRequest, RUNS_PER_DAY } from "./rules.ts";
import { Leases } from "../workflow/leases.ts";

let busy = false;

export async function runWebRead(app: Pick<App, "db" | "audit" | "config">, req: ReadRequest, actor: "cli" | "mcp", env: Record<string, string | undefined> = process.env): Promise<ReadOutcome> {
  if (app.config.env !== "test" && (!env.XN_INTERACT_READER_CDP || env.XN_INTERACT_LINKEDIN_WRITTEN_PERMISSION !== "1")) {
    throw new ReaderError("NEEDS_OWNER", "LinkedIn browser automation requires documented platform permission.", "Use permitted public career pages or official ATS boards.");
  }
  const cdp = parseReaderCdp(env.XN_INTERACT_READER_CDP);
  if (busy) throw new ReaderError("RATE_LIMITED", "another web read is still running; wait for it to finish");
  const lease = new Leases(app.db, app.config.processId);
  if (!lease.acquire("legacy-reader", 180_000)) throw new ReaderError("RATE_LIMITED", "another web read is still running; wait for it to finish");
  busy = true;
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const day = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'web.read' AND outcome = 'started' AND at > ?", since)?.n ?? 0;
    if (day >= RUNS_PER_DAY) throw new ReaderError("RATE_LIMITED", `${RUNS_PER_DAY} web reads in the last 24 hours is the cap; try again later`);
    const last = app.db.get<{ at: string | null }>("SELECT MAX(at) AS at FROM audit_events WHERE action = 'web.read' AND outcome = 'started'")?.at;
    if (last && Date.now() - Date.parse(last) < MIN_SECONDS_BETWEEN_RUNS * 1000) throw new ReaderError("RATE_LIMITED", `wait ${MIN_SECONDS_BETWEEN_RUNS} seconds between web reads`);
    app.audit.record(actor, "web.read", "started", { target: req.target });
    try {
      const out = await readWeb(cdp, req);
      app.audit.record(actor, "web.read", out.state, { target: req.target, count: out.items.length });
      return out;
    } catch (e) {
      if (e instanceof ReaderError) app.audit.record(actor, "web.read", e.code.toLowerCase(), { target: req.target });
      throw e;
    }
  } finally {
    busy = false;
    lease.release("legacy-reader");
  }
}

export function toGatewayError(e: ReaderError): GatewayError {
  const extras = { actionable_next_step: e.actionable_next_step };
  switch (e.code) {
    case "NEEDS_OWNER":
      return new GatewayError("MANUAL_ONLY", e.message, extras);
    case "RATE_LIMITED":
      return new GatewayError("RATE_LIMITED", e.message, extras);
    case "BAD_TARGET":
      return new GatewayError("VALIDATION_FAILED", e.message, extras);
    default:
      return new GatewayError("PROVIDER_UNAVAILABLE", e.message, extras);
  }
}
