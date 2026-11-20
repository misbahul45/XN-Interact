import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as z from "zod/v4";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const envSchema = z.object({
  XN_INTERACT_HOME: z.string().min(1).optional(),
  XN_INTERACT_ENV: z.enum(["production", "test"]).default("production"),
  XN_INTERACT_KEYRING: z.enum(["os", "memory", "file"]).default("os"),
  XN_INTERACT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  XN_INTERACT_CALLBACK_PORT: z.coerce.number().int().min(0).max(65535).default(47819),
  XN_INTERACT_HTTPS_PORT: z.coerce.number().int().min(0).max(65535).default(47820),
  XN_INTERACT_REDIRECT_MODE: z.enum(["auto", "loopback", "https"]).default("auto"),
  XN_INTERACT_MEDIA_ROOTS: z.string().optional(),
  XN_INTERACT_PUBLIC_MEDIA_BASE: z.string().optional(),
  XN_INTERACT_PUBLIC_MEDIA_DIR: z.string().optional(),
  XN_INTERACT_FIXTURE_PROVIDER: z.enum(["0", "1"]).default("0"),
  XN_INTERACT_TICK_MS: z.coerce.number().int().min(0).default(2000),
});

export interface Config {
  repoRoot: string;
  home: string;
  dbPath: string;
  mediaDir: string;
  mediaRoots: string[];
  /** HTTPS base URL (ending in "/") where the owner hosts approved JPEGs as <sha256>.jpg; Instagram fetches images from it. */
  publicMediaBase: string | null;
  /** Local git checkout whose files are served at publicMediaBase; `xn-interact media host` copies, commits and pushes into it. */
  publicMediaDir: string | null;
  env: "production" | "test";
  keyring: "os" | "memory" | "file";
  logLevel: "debug" | "info" | "warn" | "error";
  callbackPort: number;
  httpsPort: number;
  redirectMode: "auto" | "loopback" | "https";
  fixtureProvider: boolean;
  tickMs: number;
  processId: string;
}

/** A public media base must be a plain HTTPS directory URL: no credentials, query or fragment, and a trailing slash. */
export function parsePublicMediaBase(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("invalid configuration: XN_INTERACT_PUBLIC_MEDIA_BASE is not a URL");
  }
  if (u.protocol !== "https:") throw new Error("invalid configuration: XN_INTERACT_PUBLIC_MEDIA_BASE must be https");
  if (u.username || u.password || u.search || u.hash) throw new Error("invalid configuration: XN_INTERACT_PUBLIC_MEDIA_BASE must not carry credentials, a query or a fragment");
  if (!u.pathname.endsWith("/")) throw new Error("invalid configuration: XN_INTERACT_PUBLIC_MEDIA_BASE must end with /");
  return u.toString();
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  if (e.XN_INTERACT_KEYRING !== "os" && e.XN_INTERACT_ENV !== "test") throw new Error(`XN_INTERACT_KEYRING=${e.XN_INTERACT_KEYRING} is only allowed when XN_INTERACT_ENV=test`);
  if (e.XN_INTERACT_FIXTURE_PROVIDER === "1" && e.XN_INTERACT_ENV !== "test") throw new Error("the fixture provider is only allowed when XN_INTERACT_ENV=test");
  const home = resolve(e.XN_INTERACT_HOME ?? join(REPO_ROOT, "data"));
  const mediaDir = join(home, "media");
  const inbox = join(home, "inbox");
  const roots = (e.XN_INTERACT_MEDIA_ROOTS ?? inbox).split(":").filter(Boolean).map((r) => resolve(r));
  return {
    repoRoot: REPO_ROOT,
    home,
    dbPath: join(home, "xn-interact.sqlite"),
    mediaDir,
    mediaRoots: roots,
    publicMediaBase: parsePublicMediaBase(e.XN_INTERACT_PUBLIC_MEDIA_BASE),
    publicMediaDir: e.XN_INTERACT_PUBLIC_MEDIA_DIR ? resolve(e.XN_INTERACT_PUBLIC_MEDIA_DIR) : null,
    env: e.XN_INTERACT_ENV,
    keyring: e.XN_INTERACT_KEYRING,
    logLevel: e.XN_INTERACT_LOG_LEVEL,
    callbackPort: e.XN_INTERACT_CALLBACK_PORT,
    httpsPort: e.XN_INTERACT_HTTPS_PORT,
    redirectMode: e.XN_INTERACT_REDIRECT_MODE,
    fixtureProvider: e.XN_INTERACT_FIXTURE_PROVIDER === "1",
    tickMs: e.XN_INTERACT_TICK_MS,
    processId: `${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
  };
}

export function ensureHome(cfg: Config): void {
  for (const dir of [cfg.home, cfg.mediaDir, join(cfg.home, "inbox")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}
