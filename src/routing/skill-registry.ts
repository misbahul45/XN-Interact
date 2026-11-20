import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { CATALOG } from "../contracts/catalog.ts";

export const SKILLS_DIR = resolve(import.meta.dir, "..", "..", "skills");

const fieldSchema = z.strictObject({
  type: z.enum(["string", "string[]", "integer", "object", "datetime"]),
  required: z.boolean().optional(),
  enum: z.array(z.string().max(64)).max(50).optional(),
  max_items: z.number().int().min(1).max(100).optional(),
  max_length: z.number().int().min(1).max(100000).optional(),
});

export const skillManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_.]*$/).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  operations: z.array(z.string()).min(1).max(20),
  execution: z.enum(["direct", "workflow"]),
  workflow: z.string().regex(/^[a-z][a-z0-9_.]*@\d+$/).nullable(),
  risk: z.enum(["READ", "LOCAL_WRITE", "EXTERNAL_WRITE"]),
  approval: z.enum(["none", "trusted_user_plan_hash"]),
  targets: z.enum(["explicit_account_ids", "none"]),
  failure_policy: z.enum(["stop", "per_target_partial_success"]),
  compensate: z.literal("none"),
  output_profile: z.enum(["compact", "standard", "detailed"]),
  input: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), fieldSchema),
});

export type SkillManifest = z.infer<typeof skillManifestSchema> & { digest: string };

export function inputSchema(m: Pick<SkillManifest, "input">): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, f] of Object.entries(m.input)) {
    let t: z.ZodType;
    if (f.type === "string") t = f.enum ? z.enum(f.enum as [string, ...string[]]) : z.string().min(1).max(f.max_length ?? 4000);
    else if (f.type === "string[]") t = z.array(f.enum ? z.enum(f.enum as [string, ...string[]]) : z.string().min(1).max(200)).max(f.max_items ?? 50);
    else if (f.type === "integer") t = z.number().int().min(1).max(100);
    else if (f.type === "datetime") t = z.iso.datetime();
    else t = z.record(z.string(), z.unknown());
    shape[k] = f.required ? t : t.optional();
  }
  return z.strictObject(shape);
}

export class SkillRegistry {
  readonly skills = new Map<string, SkillManifest>();

  constructor(dir = SKILLS_DIR) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      if (text.length > 64_000) throw new Error(`skill manifest ${file} is too large`);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error(`skill manifest ${file} is not valid JSON`);
      }
      const parsed = skillManifestSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`skill manifest ${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      const m = parsed.data;
      if (`${m.id}.json` !== file) throw new Error(`skill manifest ${file} must be named ${m.id}.json`);
      if (this.skills.has(m.id)) throw new Error(`duplicate skill ${m.id}`);
      const cat = CATALOG.skills.find((s) => s.id === m.id);
      if (!cat) throw new Error(`skill ${m.id} is not in the catalog`);
      const same = cat.version === m.version && cat.execution === m.execution && cat.workflow === m.workflow && cat.risk === m.risk
        && JSON.stringify(cat.operations) === JSON.stringify(m.operations) && (cat.approval === "required") === (m.approval === "trusted_user_plan_hash");
      if (!same) throw new Error(`skill ${m.id} differs from the catalog`);
      this.skills.set(m.id, { ...m, digest: new Bun.CryptoHasher("sha256").update(text).digest("hex") });
    }
    for (const s of CATALOG.skills) if (!this.skills.has(s.id)) throw new Error(`skill ${s.id} has no manifest`);
  }

  get(id: string): SkillManifest | undefined {
    return this.skills.get(id);
  }

  list(): SkillManifest[] {
    return [...this.skills.values()];
  }
}
