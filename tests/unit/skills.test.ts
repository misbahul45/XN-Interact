import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { SKILLS_DIR, SkillRegistry } from "../../src/routing/skill-registry.ts";
import { routePublish } from "../../src/routing/skill-router.ts";
import { tempHome } from "../helpers.ts";

function copy(): string {
  const dir = mkdtempSync(join(tempHome(), "s-"));
  cpSync(SKILLS_DIR, dir, { recursive: true });
  return dir;
}

describe("gateway skills", () => {
  test("loads the 14 catalog skills", () => {
    expect(new SkillRegistry().list()).toHaveLength(CATALOG.server.expected_skill_count);
  });

  test("rejects executable, unknown, misnamed and drifted manifests", () => {
    const withCode = copy();
    const m = JSON.parse(require("node:fs").readFileSync(join(withCode, "account.audit.json"), "utf8"));
    writeFileSync(join(withCode, "account.audit.json"), JSON.stringify({ ...m, code: "process.exit(1)" }));
    expect(() => new SkillRegistry(withCode)).toThrow(/invalid/);
    const misnamed = copy();
    writeFileSync(join(misnamed, "wrong.name.json"), JSON.stringify(m));
    expect(() => new SkillRegistry(misnamed)).toThrow(/must be named|duplicate/);
    const drift = copy();
    writeFileSync(join(drift, "account.audit.json"), JSON.stringify({ ...m, risk: "EXTERNAL_WRITE" }));
    expect(() => new SkillRegistry(drift)).toThrow(/differs from the catalog/);
    const unknown = copy();
    writeFileSync(join(unknown, "spam.bulk.json"), JSON.stringify({ ...m, id: "spam.bulk" }));
    expect(() => new SkillRegistry(unknown)).toThrow(/not in the catalog/);
  });

  test("publish routing is total and deterministic", () => {
    const seen = new Map<string, string>();
    for (const media_kind of ["text", "image", "video"] as const)
      for (const target_count of ["one", "many"] as const)
        for (const scheduled of ["no", "yes"] as const) {
          const k = `${media_kind}/${target_count}/${scheduled}`;
          const s = routePublish({ media_kind, target_count, scheduled });
          expect(routePublish({ media_kind, target_count, scheduled })).toBe(s);
          seen.set(k, s);
        }
    expect(seen.get("text/one/no")).toBe("content.publish.one");
    expect(seen.get("image/one/no")).toBe("content.publish.media");
    expect(seen.get("video/many/no")).toBe("content.publish.many");
    expect(seen.get("text/one/yes")).toBe("content.schedule");
  });
});
