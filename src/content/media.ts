import { copyFileSync, chmodSync, lstatSync, openSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { GatewayError } from "../contracts/errors.ts";
import { type Db, newId, nowIso } from "../storage/db.ts";

export const LIMITS = { image: 20 * 1024 * 1024, video: 512 * 1024 * 1024 } as const;

const SIGNATURES: { mime: string; kind: "image" | "video"; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/jpeg", kind: "image", ext: ".jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", kind: "image", ext: ".png", test: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  { mime: "image/gif", kind: "image", ext: ".gif", test: (b) => String.fromCharCode(...b.slice(0, 6)) === "GIF89a" || String.fromCharCode(...b.slice(0, 6)) === "GIF87a" },
  { mime: "image/webp", kind: "image", ext: ".webp", test: (b) => String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP" },
  { mime: "video/mp4", kind: "video", ext: ".mp4", test: (b) => String.fromCharCode(...b.slice(4, 8)) === "ftyp" && !String.fromCharCode(...b.slice(8, 10)).startsWith("qt") },
  { mime: "video/quicktime", kind: "video", ext: ".mov", test: (b) => String.fromCharCode(...b.slice(4, 8)) === "ftyp" && String.fromCharCode(...b.slice(8, 10)).startsWith("qt") },
];

export interface MediaAsset {
  id: string;
  sha256: string;
  mime: string;
  kind: "image" | "video";
  size_bytes: number;
  location_ref: string;
  alt_text: string | null;
  created_at: string;
  expires_at: string;
}

export class MediaSandbox {
  constructor(private readonly db: Db, private readonly roots: string[], private readonly stageDir: string, private readonly excluded: string[] = []) {}

  private inside(real: string): boolean {
    return this.roots.some((root) => {
      let r: string;
      try {
        r = realpathSync(root);
      } catch {
        return false;
      }
      return real === r || real.startsWith(r.endsWith(sep) ? r : r + sep);
    });
  }

  async stage(path: string, altText: string | null): Promise<MediaAsset> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new GatewayError("PROHIBITED", "remote media URLs are not fetched; stage a local file", { actionable_next_step: "Download the file yourself into a media root, then stage it" });
    let lst;
    try {
      lst = lstatSync(path);
    } catch {
      throw new GatewayError("VALIDATION_FAILED", "media file not found");
    }
    if (lst.isSymbolicLink()) throw new GatewayError("PROHIBITED", "symbolic links are refused");
    if (!lst.isFile()) throw new GatewayError("PROHIBITED", "only regular files can be staged");
    const real = realpathSync(path);
    if (this.excluded.some((directory) => real === directory || real.startsWith(directory + sep))) {
      throw new GatewayError("PROHIBITED", "protected browser and dataset directories cannot be staged");
    }
    if (!this.inside(real)) throw new GatewayError("PROHIBITED", "file is outside the configured media roots", { detail: { roots: this.roots } });
    const head = new Uint8Array(16);
    const fd = openSync(real, "r");
    try {
      readSync(fd, head, 0, 16, 0);
    } finally {
      closeSync(fd);
    }
    const sig = SIGNATURES.find((s) => s.test(head));
    if (!sig) throw new GatewayError("VALIDATION_FAILED", "unsupported media type (JPEG, PNG, GIF, WebP, MP4, MOV)");
    const size = statSync(real).size;
    if (size === 0 || size > LIMITS[sig.kind]) throw new GatewayError("VALIDATION_FAILED", `${sig.kind} must be between 1 byte and ${LIMITS[sig.kind]} bytes`);
    const hasher = new Bun.CryptoHasher("sha256");
    const stream = Bun.file(real).stream();
    for await (const chunk of stream) hasher.update(chunk);
    const sha = hasher.digest("hex");
    const existing = this.db.get<MediaAsset>("SELECT * FROM media_assets WHERE sha256 = ? AND expires_at > ?", sha, nowIso());
    if (existing) return existing;
    const dest = join(this.stageDir, `${sha}${sig.ext}`);
    copyFileSync(real, dest);
    chmodSync(dest, 0o600);
    const asset: MediaAsset = { id: newId("med"), sha256: sha, mime: sig.mime, kind: sig.kind, size_bytes: size, location_ref: `staged:${sha}${sig.ext}`, alt_text: altText, created_at: nowIso(), expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() };
    this.db.run("INSERT INTO media_assets(id, sha256, mime, kind, size_bytes, location_ref, alt_text, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      asset.id, asset.sha256, asset.mime, asset.kind, asset.size_bytes, asset.location_ref, asset.alt_text, asset.created_at, asset.expires_at);
    return asset;
  }

  get(id: string): MediaAsset {
    const a = this.db.get<MediaAsset>("SELECT * FROM media_assets WHERE id = ?", id);
    if (!a) throw new GatewayError("VALIDATION_FAILED", `unknown media ${id}`);
    if (Date.parse(a.expires_at) < Date.now()) throw new GatewayError("VALIDATION_FAILED", `media ${id} expired; stage it again`);
    return a;
  }

  extOf(a: MediaAsset): string {
    return extname(a.location_ref);
  }
}
