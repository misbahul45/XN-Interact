import type { Browser, Page } from "playwright-core";
import { type FeedPost, type JobCard, parseLinkedInFeed, parseLinkedInJobs } from "./parse.ts";
import { assertReadable, buildTargetUrl, chromeLaunchHelp, isChallengeText, isChallengeUrl, parseReaderCdp, ReaderError, type ReadRequest, validateDebuggerSocket } from "./rules.ts";

export interface ReadOutcome {
  target: ReadRequest["target"];
  state: "ok" | "empty";
  source_url: string;
  total: number | null;
  items: JobCard[] | FeedPost[];
}

const MAX_FRAMES = 12;

export async function collectAria(page: Page): Promise<string> {
  const origin = new URL(page.url()).origin;
  const parts = await Promise.all(page.frames().slice(0, MAX_FRAMES).map(async (frame) => {
    try {
      return new URL(frame.url()).origin === origin ? await frame.locator("body").ariaSnapshot({ timeout: 8_000 }) : "";
    } catch {
      return "";
    }
  }));
  return parts.join("\n");
}

async function debuggerSocket(origin: string): Promise<string> {
  const response = await fetch(new URL("/json/version", parseReaderCdp(origin)), {
    redirect: "error", signal: AbortSignal.timeout(2500),
  });
  if (!response.ok || !response.body) throw new ReaderError("BAD_CDP", "Chrome debugger metadata was unavailable");
  const body = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await body.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8192) throw new ReaderError("BAD_CDP", "Chrome debugger metadata exceeded the limit");
      parts.push(value);
    }
    const document = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return validateDebuggerSocket(origin, document.webSocketDebuggerUrl);
  } finally {
    await body.cancel().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SCROLL_DOWN = "window.scrollBy(0, window.innerHeight * 3)";
const READY_STATE = "document.readyState";

const READY_MS = 35_000;
const POLL_MS = 2_000;
const NEEDS_OWNER_STEP = "Open the reader's Chrome window, sign in or finish the check yourself, then run the command again.";

function brief(e: unknown): string {
  return String(e instanceof Error ? e.message : e).split("\n")[0]!.slice(0, 200);
}

function readable(url: string): boolean {
  try {
    assertReadable(url);
    return true;
  } catch {
    return false;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(unknown)";
  }
}

async function waitForContent(page: Page, req: ReadRequest): Promise<string> {
  const deadline = Date.now() + READY_MS;
  let aria = "";
  for (;;) {
    const here = page.url();
    if (isChallengeUrl(here)) throw new ReaderError("NEEDS_OWNER", "LinkedIn asked for a login, checkpoint or CAPTCHA. The reader stops here and never tries to pass it.", NEEDS_OWNER_STEP);
    if (readable(here)) {
      aria = await collectAria(page);
      if (isChallengeText(aria)) throw new ReaderError("NEEDS_OWNER", "The page shows a security check or a sign-in form. The reader stops here.", NEEDS_OWNER_STEP);
      const ready = req.target === "linkedin-jobs" ? (() => { const r = parseLinkedInJobs(aria, 1); return r.cards.length > 0 || r.total !== null; })() : /^\s*- heading "Feed post"/m.test(aria);
      if (ready) return aria;
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  if (!readable(page.url())) throw new ReaderError("NEEDS_OWNER", `LinkedIn left the reader on a page it may not read (${pathOf(page.url())}).`, NEEDS_OWNER_STEP);
  if (aria.trim()) return aria;
  const state = await page.evaluate(READY_STATE).catch(() => "unknown");
  throw new ReaderError("NOT_READY", `the page did not render within ${READY_MS / 1000}s (path ${pathOf(page.url())}, readyState ${String(state)})`, "Check that the reader's Chrome window is open, signed in to LinkedIn and not showing a prompt, then retry.");
}

export async function readWeb(cdpUrl: string, req: ReadRequest): Promise<ReadOutcome> {
  const url = buildTargetUrl(req);
  assertReadable(url);

  const { chromium } = await import("playwright-core");
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(await debuggerSocket(cdpUrl), { timeout: 8_000 });
  } catch {
    throw new ReaderError("NOT_READY", `cannot reach Chrome's debug port at ${cdpUrl}`, chromeLaunchHelp(cdpUrl));
  }

  let page: Page | null = null;
  try {
    const context = browser.contexts()[0];
    if (!context) throw new ReaderError("NOT_READY", "the browser has no window to read from", chromeLaunchHelp(cdpUrl));

    page = await context.newPage();
    await page.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: "commit", timeout: 30_000 });

    let aria = await waitForContent(page, req);

    if (req.target === "linkedin-feed") {
      for (let i = 0; i < req.scrolls; i++) {
        await page.evaluate(SCROLL_DOWN);
        await sleep(2_500);
      }
      aria = await collectAria(page);
      if (isChallengeText(aria)) throw new ReaderError("NEEDS_OWNER", "The page shows a security check or a sign-in form. The reader stops here.", NEEDS_OWNER_STEP);
    }

    if (req.target === "linkedin-jobs") {
      const { total, cards } = parseLinkedInJobs(aria, req.max_items);
      return { target: req.target, state: cards.length ? "ok" : "empty", source_url: url, total, items: cards };
    }
    const posts = parseLinkedInFeed(aria, req.max_items);
    return { target: req.target, state: posts.length ? "ok" : "empty", source_url: url, total: null, items: posts };
  } catch (e) {
    if (e instanceof ReaderError) throw e;
    throw new ReaderError("NOT_READY", `browser error: ${brief(e)}`, "Check that the reader's Chrome window is open and signed in to LinkedIn, then retry.");
  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
