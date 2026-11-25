import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ensureHome, loadConfig } from "../../src/bootstrap/config.ts";
import { brokerCall, brokerPaths } from "../../src/browser/ipc.ts";
import { launchProfile } from "../../src/browser/runtime.ts";
import { ExtractionStore } from "../../src/extraction/store.ts";
import { Db } from "../../src/storage/db.ts";
import { migrate } from "../../src/storage/migrations.ts";
import { ROOT, testEnv } from "../helpers.ts";

const title = { name: "title", type: "string", required: true } as const;
const rank = { name: "rank", type: "number" } as const;
const extra = { name: "details.summary", type: "string", detail: true } as const;
const document = (content: string, owner = "fixture-owner") => `<!doctype html><title>Fixture</title><aside data-xn-account>${owner}</aside><main>${content}</main>`;
const record = (id: number, name = `Listing ${id}`, append = "") =>
  `<article data-xn-record="${id}"><span data-xn-field="title">${name}</span><span data-xn-field="rank">${id}</span>${append}</article>`;
const end = "<p data-xn-end>End of results</p>";
const html = (content: string) => new Response(content, { headers: { "Content-Type": "text/html;charset=utf-8" } });

async function client(env: Record<string, string>, name: string) {
  const mcp = new Client({ name, version: "1.0.0" });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src/main.ts")], env, stderr: "pipe" }));
  return {
    close: () => mcp.close(),
    async call(name: string, args: Record<string, unknown> = {}) {
      const response = await mcp.callTool({ name, arguments: args });
      return (response.structuredContent ?? { ok: !response.isError }) as { ok: boolean; data: any; error?: { code: string } };
    },
  };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 18_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error(`fixture timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}

test("headless MCP hosts share a broker, persist identity and collect exactly 1,000 unique paginated records", async () => {
  const home = mkdtempSync("/tmp/xn-headless-test-");
  const env = { ...testEnv(home, { XN_INTERACT_BROWSER_IDLE_MS: "1200" }), PATH: process.env.PATH ?? "" };
  const cfg = loadConfig(env);
  ensureHome(cfg);
  const db = new Db(cfg.dbPath);
  migrate(db, cfg.dbPath);
  const store = new ExtractionStore(db, true);
  let mismatch = false;
  let changed = false;
  let delayPage = 0;
  let expired = false;
  const hits = new Map<number, number>();
  const website = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/login") return new Response("Fixture login completed", { headers: { "Set-Cookie": "xn-fixture=synthetic-only; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600" } });
      if (expired || !request.headers.get("cookie")?.includes("xn-fixture=")) return new Response("", { status: 401 });
      if (url.pathname === "/challenge") return html(document('<h1>Verify you are human</h1><p data-xn-state="challenge">Stop</p>'));
      if (url.pathname === "/details/one") return html(document('<p data-xn-field="details.summary">Observed detail</p>'));
      if (url.pathname === "/details") return html(document(record(1, "Detail", '<a data-xn-detail href="/details/one">Details</a>') + end));
      if (url.pathname === "/uncertain") return html(document(record(1)));
      if (url.pathname === "/redirect") return Response.redirect(new URL("/outside", url));
      if (url.pathname === "/outside") return html(document(record(1, "OUTSIDE_SCOPE") + end));
      if (url.pathname === "/more") return html(document(`${record(1)}<section id="rows"></section><button type="button" data-xn-more>Load more</button>
        <script>
          let n = 1;
          const button = document.querySelector("button");
          button.onclick = () => {
            n++;
            document.querySelector("#rows").innerHTML += '<article data-xn-record="' + n + '"><b data-xn-field="title">More ' + n + '</b></article>';
            if (n === 3) { button.remove(); document.querySelector("main").innerHTML += '<p data-xn-end>End</p>'; }
          };
        </script>`));
      if (url.pathname === "/scroll") return html(document(`<div data-xn-scroll style="height:130px;overflow:auto;overflow-anchor:none">
        <div style="height:2000px;position:relative"><article style="position:absolute;top:0" data-xn-record="1"><b data-xn-field="title">Window 1</b></article></div></div>
        <script>
          let n = 1;
          const scroller = document.querySelector("[data-xn-scroll]");
          scroller.onscroll = () => {
            if (n >= 4) return;
            n++;
            scroller.querySelector("article").outerHTML = '<article style="position:absolute;top:' + scroller.scrollTop + 'px" data-xn-record="' + n + '"><b data-xn-field="title">Window ' + n + '</b></article>';
            if (n === 4) document.querySelector("main").insertAdjacentHTML("beforeend", '<p data-xn-end>End</p>');
          };
        </script>`));
      if (url.pathname !== "/catalog") return new Response("", { status: 404 });
      const number = Number(url.searchParams.get("page") ?? 1);
      hits.set(number, (hits.get(number) ?? 0) + 1);
      if (number === delayPage) await Bun.sleep(650);
      const start = (number - 1) * 100 + 1;
      const page = Array.from({ length: 100 }, (_, i) => record(start + i, changed && start + i === 1 ? "Updated posting" : undefined)).join("");
      const repeat = number === 1 ? "" : record(start - 1);
      return html(document('<p data-xn-total="1000">1000 listings</p>' + page + repeat + (number === 10 ? end : `<a rel="next" href="/catalog?page=${number + 1}">Next</a>`),
        mismatch ? "other-account" : "fixture-owner"));
    },
  });
  const origin = website.url.origin;
  for (const [id, mechanism] of [["catalog", "next"], ["details", "static"], ["challenge", "static"],
    ["uncertain", "static"], ["redirect", "static"], ["more", "load_more"], ["scroll", "scroll"]] as const) {
    store.register({
      id, url: `${origin}/${id}`, login_url: `${origin}/login`, account_marker: "fixture-owner", path_prefix: `/${id}`,
      permission: "owner_controlled", mechanism, authoritative_total: id === "catalog", fields: id === "details" ? [title, extra] : [title, rank],
    });
  }
  const authentication = await launchProfile(cfg, process.env.XN_INTERACT_FIXTURE_HEADED !== "1");
  try {
    const page = authentication.pages()[0]!;
    await page.goto(`${origin}/login`);
    expect(await page.locator("body").innerText()).toContain("Fixture login completed");
  } finally {
    await authentication.close();
  }
  const a = await client(env, "first-fixture-host");
  const b = await client(env, "second-fixture-host");
  try {
    const req = { request_id: "concurrent-extraction-1", objective: "Collect fixture", entity_type: "listing", sources: ["catalog"], fields: [title, rank], coverage: "all_accessible" };
    const start = performance.now();
    const calls = await Promise.all([a.call("social_extract_start", req), b.call("social_extract_start", req)]);
    expect(calls.every((r) => r.ok)).toBe(true);
    const id = calls[0]!.data.run_id as string;
    expect(calls[1]!.data.run_id).toBe(id);
    const broker = await brokerCall(cfg, "status");
    expect(broker?.pid).toBeGreaterThan(0);
    expect(statSync(brokerPaths(cfg).socket).mode & 0o777).toBe(0o600);
    const status = async (run: string) => {
      const response = await b.call("social_workflows_status", { run_id: run });
      expect(response.ok).toBe(true);
      return response.data;
    };
    const wait = (run: string) => until(() => status(run), (v) => !["queued", "running"].includes(v.status));
    const done = await wait(id);
    expect(done.coverage).toMatchObject({ status: "COMPLETE_WITHIN_SCOPE", expected_total: 1000, collection_coverage: 1, unique_records: 1000, duplicate_observations: 9 });
    expect(done.sources[0]).toMatchObject({ pages: 10, observations: 1009, termination: "verified_end" });
    expect([...hits.values()]).toEqual(Array(10).fill(1));
    expect(done.execution).toMatchObject({ browser_mode: "headless", extension_required: false, visible_browser_required: false });
    const rss = broker && readFileSync(`/proc/${broker.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1];
    process.stderr.write(`fixture headless cold collection elapsed_ms=${Math.round(performance.now() - start)} records=1000 pages=10 broker_rss_kib=${rss ?? "unavailable"}\n`);

    const query = await a.call("social_datasets_query", { dataset_ref: id, fields: ["title"], filter: { field: "rank", equals: 42 } });
    expect(query.data.items.map((x: any) => x.values)).toEqual([{ title: "Listing 42" }]);
    expect(JSON.stringify(query)).not.toContain("synthetic-only");
    const sorted = await b.call("social_datasets_query", { dataset_ref: id, sort: { field: "rank", direction: "desc" }, limit: 2 });
    expect(sorted.data.items.map((x: any) => x.values.rank)).toEqual([1000, 999]);
    expect(sorted.data.next_offset).toBe(2);
    for (const format of ["json", "jsonl", "csv", "sqlite"]) {
      const exported = await a.call("social_datasets_export", { dataset_ref: id, format });
      expect(exported.ok).toBe(true);
      const file = join(home, "datasets", exported.data.export_ref);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      if (format === "sqlite") {
        const sqlite = new Database(file, { readonly: true });
        expect(sqlite.query("SELECT count(*) AS n FROM records").get()).toEqual({ n: 1000 });
        sqlite.close();
      } else if (format === "json") expect(JSON.parse(readFileSync(file, "utf8")).records).toHaveLength(1000);
      else expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(format === "csv" ? 1001 : 1000);
    }

    await until(() => brokerCall(cfg, "status"), (s) => s?.browser_active === false);
    await brokerCall(cfg, "stop");
    await until(() => brokerCall(cfg, "status"), (s) => s === null);
    changed = true;
    const delta = await a.call("social_extract_start", { ...req, request_id: "after-restart-1", previous_dataset_ref: id });
    expect((await wait(delta.data.run_id)).coverage.unique_records).toBe(1000);
    expect((await brokerCall(cfg, "status"))?.pid).not.toBe(broker?.pid);
    const update = await b.call("social_datasets_query", { dataset_ref: delta.data.dataset_ref, filter: { field: "rank", equals: 1 } });
    expect(update.data.items[0]).toMatchObject({ change: "updated", values: { title: "Updated posting" } });

    const only = async (source: string, ext: Record<string, unknown> = {}) => {
      const result = await a.call("social_extract_start", { ...req, request_id: `fixture-${source}-1`, sources: [source], ...ext });
      expect(result.ok).toBe(true);
      return wait(result.data.run_id);
    };
    const details = await only("details", { detail_level: "full", fields: [title, { name: "details.summary", type: "string" }] });
    expect(details.quality.detail_success_ratio).toBe(1);
    const detail = await a.call("social_datasets_query", { dataset_ref: details.dataset_ref });
    expect(detail.data.items[0].values["details.summary"]).toBe("Observed detail");
    expect((await only("more")).coverage.unique_records).toBe(3);
    expect((await only("scroll")).coverage.unique_records).toBe(4);
    const uncertain = await only("uncertain");
    expect(uncertain.sources[0].termination).toBe("pagination_unconfirmed");
    expect(uncertain.coverage).toMatchObject({ expected_total: null, collection_coverage: null });
    expect((await only("challenge")).sources[0].termination).toBe("challenge_required");
    expect((await only("redirect")).sources[0].termination).toBe("restriction");
    expect((await only("catalog", { request_id: "fixture-budget-1", budget: { max_pages: 2 } })).coverage.status).toBe("BUDGET_REACHED");
    const partial = await only("details", { request_id: "fixture-multi-source", sources: ["challenge", "details"], fields: [title] });
    expect(partial.status).toBe("partially_succeeded");
    expect(partial.coverage.unique_records).toBe(1);

    delayPage = 3;
    const previousHits = hits.get(3)!;
    const recover = await a.call("social_extract_start", { ...req, request_id: "fixture-recovery-1" });
    await until(async () => hits.get(3) ?? 0, (n) => n > previousHits);
    expect(store.checkpoints(recover.data.run_id)[0]?.pages).toBe(2);
    await brokerCall(cfg, "stop");
    await until(() => brokerCall(cfg, "status"), (s) => s === null);
    delayPage = 0;
    expect(store.count(recover.data.run_id)).toBe(200);
    expect((await wait(recover.data.run_id)).coverage.unique_records).toBe(1000);

    expired = true;
    expect((await only("catalog", { request_id: "fixture-expired-session" })).coverage.status).toBe("SESSION_EXPIRED");
    expired = false;
    delayPage = 2;
    const cancel = await a.call("social_extract_start", { ...req, request_id: "fixture-cancel-1" });
    await until(async () => store.count(cancel.data.run_id), (n) => n === 100);
    const cancelled = await b.call("social_workflows_cancel", { run_id: cancel.data.run_id });
    expect(cancelled.data.coverage.status).toBe("CANCELLED");
    await until(() => brokerCall(cfg, "status"), (s) => s?.active_run === null);
    expect(store.count(cancel.data.run_id)).toBe(100);
    delayPage = 0;
    mismatch = true;
    expect((await only("catalog", { request_id: "fixture-account-mismatch" })).sources[0].termination).toBe("account_mismatch");

    const injection = await a.call("social_extract_start", { ...req, sources: ["unknown-source"], script: "fixture arbitrary code" });
    expect(injection.ok).toBe(false);
    expect((await a.call("social_extract_start", { ...req, request_id: "fixture-unauthorized", sources: ["unknown-source"] })).error?.code).toBe("NOT_CONNECTED");
    expect((await a.call("social_extract_start", { ...req, request_id: "fixture-prohibited", fields: [{ name: "password", type: "string" }] })).ok).toBe(false);
    db.run("DELETE FROM browser_sources WHERE id='catalog'");
    expect((await a.call("social_datasets_query", { dataset_ref: id })).error?.code).toBe("NOT_CONNECTED");
  } finally {
    await a.close();
    await b.close();
    await brokerCall(cfg, "stop");
    await until(() => brokerCall(cfg, "status"), (s) => s === null);
    await website.stop(true);
    db.close();
  }
}, 60_000);
