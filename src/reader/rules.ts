
export type ReaderErrorCode = "BAD_TARGET" | "BAD_CDP" | "NOT_READY" | "NEEDS_OWNER" | "RATE_LIMITED";

export class ReaderError extends Error {
  constructor(readonly code: ReaderErrorCode, message: string, readonly actionable_next_step?: string) {
    super(message);
    this.name = "ReaderError";
  }
}

export const READER_HOSTS: readonly string[] = ["www.linkedin.com"];

export const READER_TARGETS = ["linkedin-jobs", "linkedin-feed"] as const;
export type ReaderTarget = (typeof READER_TARGETS)[number];

export const DEFAULT_CDP = "http://127.0.0.1:9333";

export const MAX_ITEMS = 50;
export const DEFAULT_ITEMS = 25;
export const MAX_DAYS = 90;
export const RUNS_PER_DAY = 20;
export const MIN_SECONDS_BETWEEN_RUNS = 60;
export const MAX_SCROLLS = 2;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parseReaderCdp(raw: string | undefined): string {
  const value = (raw?.trim() || DEFAULT_CDP).trim();
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ReaderError("BAD_CDP", "XN_INTERACT_READER_CDP is not a URL");
  }
  if (u.protocol !== "http:") throw new ReaderError("BAD_CDP", "XN_INTERACT_READER_CDP must be http (Chrome's debug port is plain HTTP on loopback)");
  if (!LOOPBACK.has(u.hostname)) throw new ReaderError("BAD_CDP", "XN_INTERACT_READER_CDP must point at loopback (127.0.0.1, localhost or [::1]); a remote browser is refused");
  if (u.username || u.password) throw new ReaderError("BAD_CDP", "XN_INTERACT_READER_CDP must not carry credentials");
  if (!u.port) throw new ReaderError("BAD_CDP", "XN_INTERACT_READER_CDP needs an explicit port");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new ReaderError("BAD_CDP", "XN_INTERACT_READER_CDP must be an origin only, without path, query or fragment");
  return u.origin;
}

export function validateDebuggerSocket(origin: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new ReaderError("BAD_CDP", "Chrome did not advertise a supported debugger socket");
  const http = new URL(parseReaderCdp(origin));
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new ReaderError("BAD_CDP", "Chrome advertised an invalid debugger socket");
  }
  if (target.protocol !== "ws:" || !LOOPBACK.has(target.hostname) || target.port !== http.port ||
      target.username || target.password || target.search || target.hash ||
      !/^\/devtools\/browser\/[a-f0-9-]{36}$/i.test(target.pathname)) {
    throw new ReaderError("BAD_CDP", "Chrome advertised a debugger socket outside the configured loopback port");
  }
  return target.href;
}

export interface JobsRequest {
  target: "linkedin-jobs";
  keywords: string;
  geo_id: string;
  days: number;
  max_items: number;
}

export interface FeedRequest {
  target: "linkedin-feed";
  max_items: number;
  scrolls: number;
}

export type ReadRequest = JobsRequest | FeedRequest;

export const KEYWORDS = /^[\p{L}\p{N} +#&.,'-]{1,80}$/u;
export const GEO = /^\d{6,12}$/;

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

export function parseRequest(target: string | undefined, raw: Record<string, string | undefined>): ReadRequest {
  if (target === "linkedin-jobs") {
    const keywords = (raw.keywords ?? "").trim();
    if (!KEYWORDS.test(keywords)) throw new ReaderError("BAD_TARGET", "linkedin-jobs needs --keywords (1-80 letters, digits, spaces and + # & . , ' -)");
    const geo = (raw.geo ?? "").trim();
    if (!GEO.test(geo)) throw new ReaderError("BAD_TARGET", "linkedin-jobs needs --geo <LinkedIn geoId> (digits only; Indonesia is 102478259)");
    return { target, keywords, geo_id: geo, days: clampInt(raw.days, 1, MAX_DAYS, 30), max_items: clampInt(raw.max, 1, MAX_ITEMS, DEFAULT_ITEMS) };
  }
  if (target === "linkedin-feed") {
    return { target, max_items: clampInt(raw.max, 1, MAX_ITEMS, DEFAULT_ITEMS), scrolls: clampInt(raw.scrolls, 0, MAX_SCROLLS, MAX_SCROLLS) };
  }
  throw new ReaderError("BAD_TARGET", `unknown target ${target ?? "(none)"}; supported: ${READER_TARGETS.join(", ")}. Instagram is not supported.`);
}

export function buildTargetUrl(req: ReadRequest): string {
  if (req.target === "linkedin-feed") return "https://www.linkedin.com/feed/foryou/";
  const u = new URL("https://www.linkedin.com/jobs/search/");
  u.searchParams.set("keywords", req.keywords);
  u.searchParams.set("geoId", req.geo_id);
  u.searchParams.set("f_TPR", `r${req.days * 86_400}`);
  return u.toString().replace(/\+/g, "%20");
}

const READABLE_PATHS = [/^\/jobs\/search(-results)?\/?$/, /^\/feed\/(foryou\/?)?$/];

export function assertReadable(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ReaderError("BAD_TARGET", "not a URL");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new ReaderError("BAD_TARGET", "only plain https URLs are readable");
  if (!READER_HOSTS.includes(u.hostname)) throw new ReaderError("BAD_TARGET", `host ${u.hostname} is not readable`);
  if (!READABLE_PATHS.some((p) => p.test(u.pathname))) throw new ReaderError("BAD_TARGET", `path ${u.pathname} is not readable`);
  return u;
}

const CHALLENGE_URL = /(checkpoint|authwall|uas\/login|\/login|signup|challenge|captcha|\/m\/logout)/i;

export function isChallengeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return !READER_HOSTS.includes(u.hostname) || CHALLENGE_URL.test(u.pathname);
  } catch {
    return true;
  }
}

const CHALLENGE_TEXT = /(let'?s do a quick security check|security verification|verify you(?:'| a)re (?:a )?human|are you a robot|captcha|textbox "(?:Email or phone|Password)")/i;

export function isChallengeText(aria: string): boolean {
  return CHALLENGE_TEXT.test(aria);
}

export function chromeLaunchHelp(cdp: string): string {
  const port = new URL(cdp).port;
  return `Start a dedicated Chrome once: google-chrome --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.xn-interact-reader-profile, log in to LinkedIn there yourself, keep the window open, then retry.`;
}
