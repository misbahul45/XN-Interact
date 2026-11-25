import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { loadConfig, type Config, ensureHome } from "../bootstrap/config.ts";
import { GatewayError } from "../contracts/errors.ts";
import { sourceId } from "../extraction/contracts.ts";
import { executeExtraction } from "../extraction/engine.ts";
import { ExtractionStore } from "../extraction/store.ts";
import { Db } from "../storage/db.ts";
import { migrate } from "../storage/migrations.ts";
import { Leases } from "../workflow/leases.ts";
import { assertSocket, brokerCall, brokerPaths, receiveFrame, wireRequest } from "./ipc.ts";
import { BrowserRuntime, inspectPage, launchProfile, navigate, SourceStop, withSourcePage } from "./runtime.ts";

async function serve(cfg: Config, store: ExtractionStore) {
  const { socket } = brokerPaths(cfg);
  if (existsSync(socket)) {
    assertSocket(socket);
    if (await brokerCall(cfg, "status")) throw new GatewayError("PROHIBITED", "a browser broker already owns the socket");
    unlinkSync(socket);
  }
  const runtime = new BrowserRuntime(cfg);
  const leases = new Leases(store.db, cfg.processId);
  let active: string | null = null;
  let stopping = false;
  let lastActive = Date.now();
  let wake: (() => void) | undefined;
  const requestStop = () => { stopping = true; wake?.(); };
  const server = createServer((connection) => {
    connection.on("error", () => {});
    receiveFrame(connection, (line) => {
      try {
        const request = wireRequest.parse(JSON.parse(line));
        if (request.operation === "stop") requestStop();
        if (request.operation === "wake") { lastActive = Date.now(); wake?.(); }
        connection.end(`${JSON.stringify({ id: request.id, status: { pid: process.pid, browser_active: runtime.active, active_run: active, stopping } })}\n`);
      } catch {
        connection.destroy();
      }
    });
  });
  server.maxConnections = 32;
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(socket, () => {
    try {
      chmodSync(socket, 0o600);
      ready.resolve();
    } catch (error) {
      ready.reject(error);
    }
  });
  await ready.promise;
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);
  try {
    while (!stopping) {
      const run = store.next();
      if (run && leases.acquire(`extraction:${run.id}`)) {
        active = run.id;
        const heartbeat = setInterval(() => {
          try {
            if (!leases.acquire(`extraction:${run.id}`)) requestStop();
          } catch {
            requestStop();
          }
        }, 10_000);
        try {
          await executeExtraction(store, runtime, run, () => stopping);
        } finally {
          clearInterval(heartbeat);
          leases.release(`extraction:${run.id}`);
          active = null;
          lastActive = Date.now();
        }
        continue;
      }
      const idle = Date.now() - lastActive;
      if (runtime.active && idle >= cfg.browserIdleMs) await runtime.close();
      if (!cfg.browserContinuous && !run && idle >= cfg.browserIdleMs + 10_000) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
    }
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    await runtime.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(socket)) unlinkSync(socket);
  }
}

async function authenticate(cfg: Config, store: ExtractionStore, id: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new GatewayError("PROHIBITED", "interactive authentication requires the owner's terminal");
  const source = store.source(sourceId.parse(id));
  const { spec, generation } = source;
  if (!spec.login_url || !spec.account_marker) throw new GatewayError("MANUAL_ONLY", "the source has no interactive identity contract");
  const context = await launchProfile(cfg, false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const origin = new URL(spec.login_url).origin;
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      return url.origin === origin ? route.continue() : route.abort();
    });
    await page.goto(spec.login_url, { waitUntil: "domcontentloaded" });
    await rl.question("Sign in directly in Chrome and press Enter here when ready. ");
    await page.goto(spec.url, { waitUntil: "domcontentloaded" });
    await inspectPage(page, spec);
    store.source(spec.id, generation);
    store.health(spec.id, generation, "INITIAL_LOGIN_VERIFIED");
  } finally {
    rl.close();
    await context.close();
  }
  const runtime = new BrowserRuntime(cfg);
  try {
    await withSourcePage(await runtime.open(), spec, async (page) => {
      await navigate(page, spec, spec.url);
      store.source(spec.id, generation);
      store.health(spec.id, generation, "BROWSER_RESTART_VERIFIED");
    });
  } catch (error) {
    store.health(spec.id, generation, error instanceof SourceStop && error.reason === "session_expired" ? "REAUTH_REQUIRED" : "BROWSER_UNAVAILABLE");
    throw new GatewayError("MANUAL_ONLY", "account was checked interactively, but the headless restart did not verify it");
  } finally {
    await runtime.close();
  }
}

if (import.meta.main) {
  try {
    const cfg = loadConfig();
    ensureHome(cfg);
    const db = new Db(cfg.dbPath);
    try {
      migrate(db, cfg.dbPath);
      const store = new ExtractionStore(db, cfg.env === "test");
      if (Bun.argv[2] === "serve") await serve(cfg, store);
      else if (Bun.argv[2] === "authenticate") await authenticate(cfg, store, Bun.argv[3] ?? "");
      else process.exitCode = 2;
    } finally {
      db.close();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof GatewayError ? error.message : "browser broker failed"}\n`);
    process.exitCode = 2;
  }
}
