import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page, Response, Route } from "playwright-core";
import type { Config } from "../bootstrap/config.ts";
import { GatewayError } from "../contracts/errors.ts";
import { inScope, type Source } from "../extraction/contracts.ts";

export function privateDir(path: string): string {
  mkdirSync(path, { mode: 0o700, recursive: true });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || realpathSync(path) !== path) {
    throw new GatewayError("PROHIBITED", "browser data must be in an owner-only directory without symlinks");
  }
  return path;
}

export function browserDirectory(cfg: Config): string {
  privateDir(cfg.home);
  return privateDir(join(cfg.home, "browser"));
}

export async function launchProfile(cfg: Config, headless: boolean, scope: "owner" | "public" = "owner"): Promise<BrowserContext> {
  const dir = privateDir(join(browserDirectory(cfg), scope === "owner" ? "profile" : "public-profile"));
  try {
    const { chromium } = await import("playwright-core");
    const context = await chromium.launchPersistentContext(dir, {
      channel: "chrome", headless, chromiumSandbox: true, serviceWorkers: "block", acceptDownloads: false, timeout: 25_000,
    });
    context.setDefaultTimeout(8_000);
    context.setDefaultNavigationTimeout(12_000);
    return context;
  } catch {
    throw new GatewayError("PROVIDER_UNAVAILABLE", "sandboxed Google Chrome could not start", {
      actionable_next_step: "Check Chrome, the desktop user session and exclusive ownership of the XN-Interact profile.",
    });
  }
}

export class BrowserRuntime {
  private context: BrowserContext | null = null;
  private scope: "owner" | "public" | null = null;
  constructor(private readonly cfg: Config) {}

  get active() {
    return this.context !== null;
  }

  async open(scope: "owner" | "public" = "owner"): Promise<BrowserContext> {
    if (this.context && this.scope === scope) return this.context;
    if (this.context) await this.close();
    const context = await launchProfile(this.cfg, true, scope);
    try {
      await context.routeWebSocket("**/*", (socket) => socket.close({ code: 1008 }));
      await Promise.all(context.pages().map((p) => p.close().catch(() => {})));
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
    this.context = context;
    this.scope = scope;
    context.once("close", () => {
      if (this.context === context) this.context = null;
    });
    return context;
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.scope = null;
    await context?.close();
  }
}

export class SourceStop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const CHALLENGE_PATH = /\/(?:captcha|challenge|checkpoint|mfa|verify-human)(?:[/?_-]|$)/i;
const LOGIN_PATH = /\/(?:login|sign[ -]?in|authwall)(?:[/?_-]|$)/i;

export async function inspectPage(page: Page, source: Source, requireAccount = true) {
  const href = page.url();
  const url = new URL(href);
  if (url.origin !== new URL(source.url).origin) throw new SourceStop("restriction");
  if (CHALLENGE_PATH.test(url.pathname)) throw new SourceStop("challenge_required");
  if (LOGIN_PATH.test(url.pathname) || (source.login_url && url.pathname === new URL(source.login_url).pathname)) throw new SourceStop("session_expired");
  if (!inScope(source, href)) throw new SourceStop("restriction");
  const status = await page.locator("body").evaluate((body) => {
    const visible = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";
    const matches = (selector: string) => Array.from(body.querySelectorAll(selector)).filter(visible);
    const challenge = matches('[data-xn-state="challenge"], iframe[src*="captcha"], input[autocomplete="one-time-code"]').length > 0 ||
      matches('h1,h2,[role="alert"]').slice(0, 12).some((node) => /captcha|verify (?:that )?you are human|security verification/i.test(node.textContent ?? ""));
    return {
      challenge,
      login: matches('input[type="password"], [data-xn-state="login"]').length > 0,
      restricted: matches('[data-xn-state="restricted"]').length > 0,
      account: matches("[data-xn-account]").slice(0, 2).map((node) => (node as HTMLElement).innerText.trim().slice(0, 128)),
    };
  });
  if (!inScope(source, page.url())) throw new SourceStop("restriction");
  if (status.challenge) throw new SourceStop("challenge_required");
  if (status.login || (requireAccount && source.account_marker && status.account.length === 0)) throw new SourceStop("session_expired");
  if (status.restricted) throw new SourceStop("restriction");
  if (requireAccount && source.account_marker && (status.account.length !== 1 || status.account[0] !== source.account_marker)) {
    throw new SourceStop("account_mismatch");
  }
}

export async function withSourcePage<T>(context: BrowserContext, source: Source, task: (page: Page) => Promise<T>): Promise<T> {
  const origin = new URL(source.url).origin;
  let blockedNavigation = false;
  const route = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const safeMethod = request.method() === "GET" || request.method() === "HEAD";
    const scoped = request.isNavigationRequest() || ["xhr", "fetch", "eventsource"].includes(request.resourceType());
    const safeDestination = url.origin === origin && (!scoped ||
      (inScope(source, url.href) || (source.login_url && url.href === source.login_url)));
    if ((!safeMethod || !safeDestination) && request.isNavigationRequest()) blockedNavigation = true;
    await (safeMethod && safeDestination ? route.continue() : route.abort());
  };
  await context.route("**/*", route);
  const page = await context.newPage();
  let popup = false;
  const closePopup = (newPage: Page) => {
    popup = true;
    void newPage.close().catch(() => {});
    void page.close().catch(() => {});
  };
  context.on("page", closePopup);
  try {
    const result = await task(page);
    if (popup || blockedNavigation) throw new SourceStop("restriction");
    return result;
  } catch (error) {
    if (popup || blockedNavigation) throw new SourceStop("restriction");
    throw error;
  } finally {
    context.off("page", closePopup);
    await page.close().catch(() => {});
    await context.unroute("**/*", route).catch(() => {});
  }
}

export async function navigate(page: Page, source: Source, url: string, timeout = 12_000) {
  if (!inScope(source, url)) throw new SourceStop("restriction");
  let status = 0;
  const recordStatus = (response: Response) => {
    const request = response.request();
    if (request.isNavigationRequest() && inScope(source, response.url()) && request.frame() === page.mainFrame()) {
      status = response.status();
    }
  };
  page.on("response", recordStatus);
  try {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      status = response?.status() ?? status;
    } catch (error) {
      if (status < 400) throw error;
    }
  } finally {
    page.off("response", recordStatus);
  }
  if ([401, 403, 429, 451].includes(status)) throw new SourceStop(status === 401 ? "session_expired" : "restriction");
  if (status >= 400) throw new SourceStop("page_unavailable");
  await inspectPage(page, source);
}
