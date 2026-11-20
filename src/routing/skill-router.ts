import { CATALOG } from "../contracts/catalog.ts";
import { GatewayError } from "../contracts/errors.ts";

export interface RouteKey {
  media_kind: "text" | "image" | "video";
  target_count: "one" | "many";
  scheduled: "no" | "yes";
}

export function routePublish(key: RouteKey): string {
  const sr = CATALOG.skill_routes;
  const dims = Object.keys(sr.dimensions);
  const hits = sr.routes
    .filter((r) => dims.every((d) => (r.match[d] ?? "*") === "*" || r.match[d] === key[d as keyof RouteKey]))
    .map((r) => ({ skill: r.skill, score: r.priority * 100 + Object.values(r.match).filter((v) => v !== "*").length }));
  if (!hits.length) throw new GatewayError("UNSUPPORTED", "no skill handles this publish shape", { detail: { ...key } });
  const best = Math.max(...hits.map((h) => h.score));
  const winners = [...new Set(hits.filter((h) => h.score === best).map((h) => h.skill))];
  if (winners.length !== 1) throw new GatewayError("AMBIGUOUS_SKILL", "more than one skill matches", { detail: { choices: winners } });
  return winners[0]!;
}

export function childWorkflowFor(operation: string): string {
  return operation === "content.publish.text" ? "content.publish@1" : "content.media_publish@1";
}
