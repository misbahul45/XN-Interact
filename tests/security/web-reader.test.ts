import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseLinkedInFeed, parseLinkedInJobs, redactContact } from "../../src/reader/parse.ts";
import { MAX_DAYS, MAX_ITEMS, assertReadable, buildTargetUrl, isChallengeText, isChallengeUrl, parseReaderCdp, parseRequest, validateDebuggerSocket } from "../../src/reader/rules.ts";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { TOOL_SPECS } from "../../src/routing/gateway.ts";
import { openApp, ROOT, tempHome, testEnv } from "../helpers.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const READER = join(ROOT, "src/reader/web-reader.ts");
const fixture = (name: string) => readFileSync(join(ROOT, "tests/fixtures", name), "utf8");

describe("web reader guards (T27)", () => {
  test("Playwright imports stay in browser adapters and the legacy reader uses no mutation or credential API", () => {
    const allowed = new Set([READER, join(ROOT, "src/browser/runtime.ts"), join(ROOT, "src/extraction/browser-adapter.ts"), join(ROOT, "src/extraction/engine.ts")]);
    for (const f of files(join(ROOT, "src"))) {
      const imports = /(from\s+|import\(\s*)["']playwright-core["']/.test(readFileSync(f, "utf8"));
      expect(imports, relative(ROOT, f)).toBe(allowed.has(f));
    }
    const text = readFileSync(READER, "utf8");
    const forbidden = [/\.click\(/, /\.dblclick\(/, /\.tap\(/, /\.fill\(/, /\.type\(/, /\.press\(/, /\.check\(/, /\.uncheck\(/, /\.selectOption\(/, /\.setInputFiles\(/, /\.dispatchEvent\(/, /\.hover\(/, /\.dragTo\(/, /keyboard/, /\.mouse\b/, /\.cookies\(/, /addCookies/, /storageState/, /localStorage/, /sessionStorage/, /\.route\(/, /setExtraHTTPHeaders/, /exposeFunction/, /addInitScript/, /launchPersistentContext/, /\.launch\(/];
    for (const re of forbidden) expect(re.test(text), String(re)).toBe(false);
  });

  test("playwright-core is loaded only when a read runs, never at server start", () => {
    const text = readFileSync(READER, "utf8");
    expect(/^import\s+(?!type\b)[^\n]*["']playwright-core["']/m.test(text)).toBe(false);
    expect(text).toContain('await import("playwright-core")');
  });

  test("the debug endpoint must be a plain http loopback origin with an explicit port", () => {
    expect(parseReaderCdp(undefined)).toBe("http://127.0.0.1:9333");
    expect(parseReaderCdp("http://localhost:9222")).toBe("http://localhost:9222");
    for (const bad of ["http://192.168.1.5:9222", "http://example.com:9222", "https://127.0.0.1:9222", "http://user:pw@127.0.0.1:9222", "http://127.0.0.1", "http://127.0.0.1:9222/json", "not a url"]) {
      expect(() => parseReaderCdp(bad), bad).toThrow();
    }
  });

  test("the advertised debugger socket stays on the configured loopback port", () => {
    const origin = "http://127.0.0.1:9333";
    const path = "/devtools/browser/e700cf0f-1f37-4237-9780-9ffaeeaed1d4";
    expect(validateDebuggerSocket(origin, `ws://127.0.0.1:9333${path}`)).toBe(`ws://127.0.0.1:9333${path}`);
    for (const candidate of [`wss://example.org:9333${path}`, `ws://192.0.2.1:9333${path}`, `ws://127.0.0.1:9222${path}`, `ws://127.0.0.1:9333${path}?x=1`]) {
      expect(() => validateDebuggerSocket(origin, candidate)).toThrow();
    }
  });

  test("only the allowed LinkedIn read paths on https can be opened", () => {
    expect(assertReadable("https://www.linkedin.com/jobs/search/?keywords=x").pathname).toBe("/jobs/search/");
    expect(assertReadable("https://www.linkedin.com/jobs/search-results/?currentJobId=1").pathname).toBe("/jobs/search-results/");
    expect(assertReadable("https://www.linkedin.com/feed/foryou/").pathname).toBe("/feed/foryou/");
    for (const bad of ["http://www.linkedin.com/feed/", "https://linkedin.com/feed/", "https://www.instagram.com/explore/tags/job/", "https://evil.example/jobs/search/", "https://www.linkedin.com/in/someone/", "https://www.linkedin.com/messaging/", "https://www.linkedin.com/jobs/apply/123", "https://user:pw@www.linkedin.com/feed/", "https://www.linkedin.com:8443/feed/", "javascript:alert(1)"]) {
      expect(() => assertReadable(bad), bad).toThrow();
    }
  });

  test("login, checkpoint and CAPTCHA pages stop the reader instead of being passed", () => {
    for (const u of ["https://www.linkedin.com/checkpoint/challenge/abc", "https://www.linkedin.com/uas/login?x=1", "https://www.linkedin.com/authwall?trk=1", "https://www.linkedin.com/login", "https://other.example/feed/"]) expect(isChallengeUrl(u), u).toBe(true);
    expect(isChallengeUrl("https://www.linkedin.com/jobs/search-results/?a=1")).toBe(false);
    expect(isChallengeText('- heading "Let\'s do a quick security check"')).toBe(true);
    expect(isChallengeText('- textbox "Email or phone"')).toBe(true);
    expect(isChallengeText("- paragraph: 33 results")).toBe(false);
  });

  test("requests are validated and clamped, and the URL is built only from validated parts", () => {
    expect(() => parseRequest("linkedin-jobs", { geo: "102478259" })).toThrow();
    expect(() => parseRequest("linkedin-jobs", { keywords: "fellowship", geo: "abc" })).toThrow();
    expect(() => parseRequest("linkedin-jobs", { keywords: "x".repeat(81), geo: "102478259" })).toThrow();
    expect(() => parseRequest("linkedin-jobs", { keywords: "a/../b?c", geo: "102478259" })).toThrow();
    expect(() => parseRequest("instagram-tag", { keywords: "job" })).toThrow(/not supported/);
    const big = parseRequest("linkedin-jobs", { keywords: "fellowship", geo: "102478259", days: "9999", max: "9999" });
    expect(big).toMatchObject({ days: MAX_DAYS, max_items: MAX_ITEMS });
    const url = new URL(buildTargetUrl(parseRequest("linkedin-jobs", { keywords: "R&D #1 +ai", geo: "102478259", days: "30" })));
    expect([...url.searchParams.keys()].sort()).toEqual(["f_TPR", "geoId", "keywords"]);
    expect(url.searchParams.get("keywords")).toBe("R&D #1 +ai");
    expect(url.searchParams.get("f_TPR")).toBe("r2592000");
    expect(url.hostname).toBe("www.linkedin.com");
    expect(buildTargetUrl(parseRequest("linkedin-feed", {}))).toBe("https://www.linkedin.com/feed/foryou/");
  });
});

describe("web reader parsers", () => {
  test("job cards parse from a synthetic LinkedIn accessibility snapshot", () => {
    const { total, cards } = parseLinkedInJobs(fixture("linkedin-jobs.aria.txt"), 25);
    expect(total).toBe(33);
    expect(cards).toEqual([
      { title: "Hospitality Trainee", company: "Example Lodging", location: "Jakarta", posted: "1 week ago", easy_apply: false },
      { title: "Logistics Graduate Program", company: "Example Shipping", location: "Surabaya (On-site)", posted: "3 weeks ago", easy_apply: true },
      { title: "Energy Engineering Intern", company: "Example Energy", location: "Jakarta, Indonesia (Hybrid)", posted: "5 days ago", easy_apply: false },
    ]);
    expect(parseLinkedInJobs(fixture("linkedin-jobs.aria.txt"), 2).cards).toHaveLength(2);
    expect(parseLinkedInJobs("- paragraph: nothing here", 10)).toEqual({ total: null, cards: [] });
  });

  test("same-origin frame snapshots in Playwright format parse with synthetic records", () => {
    expect(parseLinkedInJobs(fixture("linkedin-jobs.playwright-core.aria.txt"), 5)).toEqual({
      total: 33,
      cards: [{ title: "Energy Engineering Intern", company: "Example Energy", location: "Jakarta, Indonesia (Hybrid)", posted: "5 days ago", easy_apply: false }],
    });
    const text = readFileSync(READER, "utf8");
    expect(text).toContain("page.frames()");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code.match(/\.ariaSnapshot\(/g)).toHaveLength(1);
    expect(code).toContain("frame.locator(\"body\").ariaSnapshot(");
  });

  test("feed posts keep only opportunity posts, drop contact details and flag promoted ones", () => {
    const posts = parseLinkedInFeed(fixture("linkedin-feed.aria.txt"), 25);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ source_company: "example-scholarships", age: "2d", promoted: false });
    expect(posts[0]!.keywords).toEqual(expect.arrayContaining(["internship", "funded", "deadline"]));
    expect(posts[0]!.excerpt).toContain("[email]");
    expect(posts[0]!.excerpt).toContain("[phone]");
    expect(posts[0]!.excerpt).not.toContain("recruiter@example.com");
    expect(posts[0]!.excerpt).not.toContain("3456 7890");
    expect(posts[1]).toMatchObject({ source_company: "acme", promoted: true, age: "1w" });
    expect(parseLinkedInFeed(fixture("linkedin-feed.aria.txt"), 1)).toHaveLength(1);
  });

  test("page text is stripped of control characters and cut to a bound", () => {
    const aria = `- heading "Feed post"\n- text: "hiring ${"x".repeat(5000)}\\u0007\\u001b[31m end"`;
    const [post] = parseLinkedInFeed(aria, 5);
    expect(post!.excerpt.length).toBeLessThanOrEqual(700);
    expect(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(post!.excerpt)).toBe(false);
    expect(redactContact("write to a.b+c@mail.example.org or call 0812-3456-7890")).toBe("write to [email] or call [phone]");
  });
});

describe("web-read CLI", () => {
  test("an unreachable Chrome fails closed with the launch instruction and writes an audit event without page content", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file", XN_INTERACT_READER_CDP: "http://127.0.0.1:1" }), PATH: process.env.PATH ?? "" };
    expect(Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "doctor"], { env }).exitCode).toBe(0);
    const run = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "web-read", "linkedin-jobs", "--keywords", "fellowship", "--geo", "102478259"], { env });
    expect(run.exitCode).toBe(2);
    const out = JSON.parse(run.stdout.toString());
    expect(out).toMatchObject({ ok: false, state: "not_ready" });
    expect(out.actionable_next_step).toContain("--remote-debugging-port=1");
    const audit = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "audit", "export"], { env }).stdout.toString();
    expect(audit).toContain("web.read");
    expect(audit).not.toContain("fellowship");
  }, 60000);

  test("a bad target is refused before any browser is contacted", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file", XN_INTERACT_READER_CDP: "http://127.0.0.1:1" }), PATH: process.env.PATH ?? "" };
    const run = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "web-read", "instagram-tag", "--keywords", "job"], { env });
    expect(run.exitCode).toBe(2);
    expect(JSON.parse(run.stdout.toString())).toMatchObject({ ok: false, state: "bad_target" });
  }, 60000);
});

describe("web reader MCP tools", () => {
  const TOOLS = ["social_web_feed_read", "social_web_jobs_search"];

  test("both tools are READ tools without approval, and no input can name a URL, host, account or path", () => {
    for (const name of TOOLS) {
      const t = CATALOG.tools.find((x) => x.name === name)!;
      expect(t).toMatchObject({ risk: "READ", approval: "none", side_effect: "none", route: { kind: "direct" } });
      expect(t.modes).toBeUndefined();
      const keys = Object.keys(TOOL_SPECS[name]!.input.shape);
      expect(keys.filter((k) => /url|uri|host|path|account|cdp|endpoint|selector|script|cookie/i.test(k)), name).toEqual([]);
    }
  });

  test("unknown keys and out-of-range values are rejected before any browser is contacted", async () => {
    const ctx = await openApp();
    try {
      const bad: [string, Record<string, unknown>][] = [
        ["social_web_jobs_search", { keywords: "fellowship", geo_id: "102478259", url: "https://evil.example/" }],
        ["social_web_jobs_search", { keywords: "fellowship", geo_id: "abc" }],
        ["social_web_jobs_search", { keywords: "a/../b?c", geo_id: "102478259" }],
        ["social_web_jobs_search", { keywords: "fellowship", geo_id: "102478259", max_items: 999 }],
        ["social_web_jobs_search", { keywords: "fellowship", geo_id: "102478259", days: 0 }],
        ["social_web_feed_read", { scrolls: 50 }],
        ["social_web_feed_read", { script: "document.cookie" }],
      ];
      for (const [tool, args] of bad) {
        const r = await ctx.call(tool, args);
        expect(r.ok, `${tool} ${JSON.stringify(args)}`).toBe(false);
        expect((r as any).error.code).toBe("VALIDATION_FAILED");
      }
      expect(ctx.app.db.all("SELECT 1 FROM audit_events WHERE action = 'web.read'")).toEqual([]);
    } finally {
      ctx.app.close();
    }
  });

  test("an unreachable Chrome fails closed as PROVIDER_UNAVAILABLE with the launch instruction, and a second read inside the gap is RATE_LIMITED", async () => {
    const ctx = await openApp();
    const saved = process.env.XN_INTERACT_READER_CDP;
    process.env.XN_INTERACT_READER_CDP = "http://127.0.0.1:1";
    try {
      const first: any = await ctx.call("social_web_jobs_search", { keywords: "fellowship", geo_id: "102478259" });
      expect(first.ok).toBe(false);
      expect(first.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(first.error.actionable_next_step).toContain("--remote-debugging-port=1");
      const second: any = await ctx.call("social_web_feed_read", {});
      expect(second.error.code).toBe("RATE_LIMITED");
      expect(second.error.retryable).toBe(true);
      const audit = ctx.app.audit.exportScrubbed();
      expect(audit).toContain("web.read");
      expect(audit).toContain('"actor":"mcp"');
      expect(audit).not.toContain("fellowship");
    } finally {
      if (saved === undefined) delete process.env.XN_INTERACT_READER_CDP;
      else process.env.XN_INTERACT_READER_CDP = saved;
      ctx.app.close();
    }
  });

  test("the daily cap counts runs, not events, and applies to the tools as it does to the CLI", async () => {
    const ctx = await openApp();
    const saved = process.env.XN_INTERACT_READER_CDP;
    process.env.XN_INTERACT_READER_CDP = "http://127.0.0.1:1";
    try {
      const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
      for (let i = 0; i < 19; i++) ctx.app.db.run("INSERT INTO audit_events(at, actor, action, account_id, outcome, redacted_json) VALUES (?, 'mcp', 'web.read', NULL, 'started', '{}')", earlier);
      for (let i = 0; i < 19; i++) ctx.app.db.run("INSERT INTO audit_events(at, actor, action, account_id, outcome, redacted_json) VALUES (?, 'mcp', 'web.read', NULL, 'ok', '{}')", earlier);
      const nineteen: any = await ctx.call("social_web_feed_read", {});
      expect(nineteen.error.code).toBe("PROVIDER_UNAVAILABLE");
      ctx.app.db.run("UPDATE audit_events SET at = ? WHERE at > ?", earlier, earlier);
      const twentieth: any = await ctx.call("social_web_feed_read", {});
      expect(twentieth.error.code).toBe("RATE_LIMITED");
      expect(twentieth.error.message).toContain("20 web reads");
    } finally {
      if (saved === undefined) delete process.env.XN_INTERACT_READER_CDP;
      else process.env.XN_INTERACT_READER_CDP = saved;
      ctx.app.close();
    }
  });
});
