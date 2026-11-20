import { redactor } from "./redact.ts";
import { type Db, nowIso } from "../storage/db.ts";

export class Audit {
  constructor(private readonly db: Db) {}

  record(actor: string, action: string, outcome: string, detail: Record<string, unknown> = {}, accountId: string | null = null): void {
    const payload = JSON.stringify(redactor.value(detail));
    this.db.run("INSERT INTO audit_events(at, actor, action, account_id, outcome, redacted_json) VALUES (?, ?, ?, ?, ?, ?)", nowIso(), actor, action, accountId, outcome, payload);
  }

  recent(limit = 50): Record<string, unknown>[] {
    return this.db.all("SELECT at, actor, action, account_id, outcome, redacted_json FROM audit_events ORDER BY id DESC LIMIT ?", limit);
  }

  exportScrubbed(): string {
    return this.db
      .all<Record<string, unknown>>("SELECT at, actor, action, account_id, outcome, redacted_json FROM audit_events ORDER BY id")
      .map((r) => redactor.text(JSON.stringify(r)))
      .join("\n");
  }
}
