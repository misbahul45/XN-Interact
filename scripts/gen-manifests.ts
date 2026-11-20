import { CATALOG } from "../src/contracts/catalog.ts";

type Field = { type: "string" | "string[]" | "integer" | "object" | "datetime"; required?: boolean; enum?: string[]; max_items?: number; max_length?: number };

const INPUTS: Record<string, Record<string, Field>> = {
  "account.connect": { provider: { type: "string", required: true, max_length: 32 }, operations: { type: "string[]", max_items: 30 } },
  "account.inspect": { account_id: { type: "string", required: true } },
  "account.reauthorize": { account_id: { type: "string", required: true }, operations: { type: "string[]", max_items: 30 } },
  "account.audit": {},
  "content.prepare": { text: { type: "string", max_length: 10000 }, media_ids: { type: "string[]", max_items: 10 }, title: { type: "string", max_length: 300 }, link: { type: "string", max_length: 2000 }, overrides: { type: "object" } },
  "content.publish.one": { account_ids: { type: "string[]", required: true, max_items: 1 }, draft_id: { type: "string", required: true }, native: { type: "object" } },
  "content.publish.many": { account_ids: { type: "string[]", required: true, max_items: 20 }, draft_id: { type: "string", required: true }, native: { type: "object" } },
  "content.publish.media": { account_ids: { type: "string[]", required: true, max_items: 1 }, draft_id: { type: "string", required: true }, native: { type: "object" } },
  "content.schedule": { account_ids: { type: "string[]", required: true, max_items: 20 }, draft_id: { type: "string", required: true }, schedule_at: { type: "datetime", required: true }, native: { type: "object" } },
  "engagement.review": { account_id: { type: "string", required: true }, content_id: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer" } },
  "engagement.respond": { account_id: { type: "string", required: true }, action: { type: "string", required: true, enum: ["reply", "react", "hide"] }, target_id: { type: "string", required: true }, text: { type: "string", max_length: 2000 } },
  "analytics.snapshot": { account_ids: { type: "string[]", required: true, max_items: 20 } },
  "search.crossplatform": { account_ids: { type: "string[]", required: true, max_items: 20 }, query: { type: "string", required: true, max_length: 300 } },
  "ops.recover": { run_ids: { type: "string[]", max_items: 50 } },
};

for (const s of CATALOG.skills) {
  const input = INPUTS[s.id];
  if (!input) throw new Error(`no input spec for ${s.id}`);
  const manifest = {
    id: s.id,
    version: s.version,
    operations: s.operations,
    execution: s.execution,
    workflow: s.workflow,
    risk: s.risk,
    approval: s.approval === "required" ? "trusted_user_plan_hash" : "none",
    targets: Object.keys(input).some((k) => k.startsWith("account_id")) ? "explicit_account_ids" : "none",
    failure_policy: s.failure_policy,
    compensate: "none",
    output_profile: "compact",
    input,
  };
  await Bun.write(`skills/${s.id}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}
for (const w of CATALOG.workflows) await Bun.write(`workflows/${w.id}.json`, `${JSON.stringify(w, null, 2)}\n`);
console.log(`wrote ${CATALOG.skills.length} skills and ${CATALOG.workflows.length} workflows`);
