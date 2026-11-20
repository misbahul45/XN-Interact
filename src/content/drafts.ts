import { digest } from "../contracts/canonical.ts";
import { GatewayError } from "../contracts/errors.ts";
import { type Db, jsonOr, newId, nowIso } from "../storage/db.ts";
import type { MediaSandbox } from "./media.ts";

export interface DraftPayload {
  text: string;
  title: string | null;
  link: string | null;
  media_ids: string[];
  overrides: Record<string, { text?: string }>;
}

export interface Draft {
  id: string;
  content_digest: string;
  payload: DraftPayload;
  media_kind: "text" | "image" | "video";
  created_at: string;
  updated_at: string;
}

export class Drafts {
  constructor(private readonly db: Db, private readonly media: MediaSandbox) {}

  private compute(p: DraftPayload): { digest: string; kind: Draft["media_kind"] } {
    const assets = p.media_ids.map((id) => this.media.get(id));
    const kinds = new Set(assets.map((a) => a.kind));
    if (kinds.size > 1) throw new GatewayError("VALIDATION_FAILED", "a draft cannot mix images and videos");
    const kind: Draft["media_kind"] = assets.length ? (assets[0]!.kind) : "text";
    return { digest: digest({ ...p, media: assets.map((a) => a.sha256) }), kind };
  }

  save(p: DraftPayload, draftId?: string): Draft {
    if (!p.text.trim() && !p.media_ids.length) throw new GatewayError("VALIDATION_FAILED", "a draft needs text or media");
    const { digest: d } = this.compute(p);
    const now = nowIso();
    if (draftId) {
      const r = this.db.run("UPDATE content_drafts SET content_digest = ?, payload_json = ?, updated_at = ? WHERE id = ? AND state = 'draft'", d, JSON.stringify(p), now, draftId);
      if (r.changes !== 1) throw new GatewayError("VALIDATION_FAILED", `unknown draft ${draftId}`);
      return this.get(draftId);
    }
    const id = newId("drf");
    this.db.run("INSERT INTO content_drafts(id, content_digest, payload_json, state, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)", id, d, JSON.stringify(p), now, now);
    return this.get(id);
  }

  get(id: string): Draft {
    const r = this.db.get<{ id: string; content_digest: string; payload_json: string; created_at: string; updated_at: string }>("SELECT * FROM content_drafts WHERE id = ?", id);
    if (!r) throw new GatewayError("VALIDATION_FAILED", `unknown draft ${id}`);
    const payload = jsonOr<DraftPayload>(r.payload_json, { text: "", title: null, link: null, media_ids: [], overrides: {} });
    const { digest: d, kind } = this.compute(payload);
    if (d !== r.content_digest) throw new GatewayError("PLAN_CHANGED", "draft content changed underneath its digest (media replaced or expired)");
    return { id: r.id, content_digest: r.content_digest, payload, media_kind: kind, created_at: r.created_at, updated_at: r.updated_at };
  }

  textFor(d: Draft, provider: string): string {
    return d.payload.overrides[provider]?.text ?? d.payload.text;
  }
}
