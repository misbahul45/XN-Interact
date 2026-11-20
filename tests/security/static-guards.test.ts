import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "../helpers.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const SRC = files(join(ROOT, "src"));
const FORBIDDEN_PACKAGES = /["'](openai|@anthropic-ai\/[^"']+|anthropic|langchain|@langchain\/[^"']+|langgraph|playwright|puppeteer|selenium-webdriver|react|react-dom|vite|next|express|ioredis|redis|pg|postgres|better-sqlite3|ws|dotenv|axios|node-fetch)["']/;

describe("static guards", () => {
  test("no model SDK, browser automation, frontend or extra infrastructure dependency", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies });
    expect(deps.sort()).toEqual(["@modelcontextprotocol/server", "zod"]);
    for (const f of SRC) expect(FORBIDDEN_PACKAGES.test(readFileSync(f, "utf8").match(/from\s+["'][^"']+["']/g)?.join("\n") ?? "")).toBe(false);
  });

  test("network calls only in the provider transport and the callback peer ping", () => {
    const allowed = new Set(["src/transport/provider-http.ts", "src/identity/callback-listener.ts"]);
    for (const f of SRC) {
      const text = readFileSync(f, "utf8");
      if (/\bfetch\s*\(|new\s+WebSocket|Bun\.connect|node:net|node:http/.test(text)) expect(allowed.has(relative(ROOT, f))).toBe(true);
    }
  });

  test("stdout is reserved: no console.log outside the entrypoints", () => {
    for (const f of SRC) {
      const rel = relative(ROOT, f);
      if (rel === "src/cli.ts" || rel === "src/main.ts") continue;
      expect(/console\.(log|info)\(/.test(readFileSync(f, "utf8"))).toBe(false);
    }
  });

  test("no dynamic code execution from manifests or provider content", () => {
    for (const f of SRC) expect(/\beval\(|new Function\(|import\(\s*[^"'\s]/.test(readFileSync(f, "utf8"))).toBe(false);
  });

  test("the fixture provider is unreachable in production configuration", async () => {
    const { loadConfig } = await import("../../src/bootstrap/config.ts");
    expect(() => loadConfig({ XN_INTERACT_FIXTURE_PROVIDER: "1" })).toThrow();
    expect(() => loadConfig({ XN_INTERACT_KEYRING: "memory" })).toThrow();
  });
});
