import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TOKENIZER, countTokens, registryStats, type ToolListEntry } from "../../src/performance/benchmark.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";
import { SCENARIOS } from "./scenarios.ts";

async function listTools(): Promise<ToolListEntry[]> {
  const c = new Client({ name: "bench", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src/main.ts")], env: { ...testEnv(tempHome(), { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" }, stderr: "pipe" }));
  try {
    return (await c.listTools()).tools as ToolListEntry[];
  } finally {
    await c.close();
  }
}

describe("token benchmark harness", () => {
  test("the tokenizer is pinned and deterministic", () => {
    expect(TOKENIZER.version).toBe("4.1.2");
    expect(countTokens("posting ke linkedin")).toBe(countTokens("posting ke linkedin"));
    expect(countTokens("")).toBe(0);
  });

  test("registry size over real stdio stays inside the regression budget", async () => {
    const s = registryStats(await listTools());
    expect(s.tools).toBe(22);
    expect(s.tokens).toBeLessThan(5000);
    expect(s.tokens_without_output_schema).toBe(s.tokens);
  }, 60000);

  test("every canonical scenario runs, and compact output is never larger than detailed", async () => {
    const withProfile = new Set(["list_accounts", "inspect_capability", "read_paginated", "write_timeout"]);
    for (const sc of SCENARIOS) {
      const compact = await sc.run("compact");
      expect(compact.calls).toBeGreaterThan(0);
      expect(compact.total_tokens).toBeGreaterThan(0);
      if (withProfile.has(sc.id)) {
        const detailed = await sc.run("detailed");
        expect(compact.out_tokens).toBeLessThanOrEqual(detailed.out_tokens);
      }
    }
  }, 180000);

  test("scenario token counts are stable between runs", async () => {
    const sc = SCENARIOS.find((s) => s.id === "list_accounts")!;
    const [a, b] = [await sc.run("compact"), await sc.run("compact")];
    expect(Math.abs(a.total_tokens - b.total_tokens)).toBeLessThanOrEqual(Math.max(a.total_tokens * 0.05, 10));
  }, 60000);
});
