import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CATALOG } from "../../src/contracts/catalog.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";

let client: Client;
let stderr = "";

beforeAll(async () => {
  const home = tempHome();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "src/main.ts")],
    env: { ...testEnv(home, { XN_INTERACT_KEYRING: "file", XN_INTERACT_FIXTURE_PROVIDER: "1", XN_INTERACT_TICK_MS: "0" }), PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  client = new Client({ name: "contract-test", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => client?.close());

function env(r: unknown): any {
  return (r as { structuredContent: unknown }).structuredContent;
}

describe("stdio MCP contract", () => {
  test("tools/list equals the catalog: 22 snake_case tools with annotations and schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(CATALOG.tools.map((t) => t.name).sort());
    for (const t of tools) {
      const c = CATALOG.tools.find((x) => x.name === t.name)!;
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema).toBeUndefined();
      expect(t.annotations?.readOnlyHint).toBe(c.risk === "READ");
      expect(t.annotations?.destructiveHint).toBe(c.side_effect === "destructive");
    }
    const bytes = JSON.stringify(tools).length;
    expect(bytes).toBeLessThan(40_000);
  });

  test("1,000 successive calls round-trip without stdout corruption", async () => {
    for (let i = 0; i < 1000; i++) {
      const r = await client.callTool({ name: "social_approvals_status", arguments: {} });
      expect(env(r).ok).toBe(true);
    }
  });

  test("validation and unknown arguments return isError envelopes", async () => {
    const r = await client.callTool({ name: "social_capabilities_get", arguments: { account_id: "nope" } });
    expect(r.isError).toBe(true);
    const strict = await client.callTool({ name: "social_system_health", arguments: { profile: "compact", confirm: true } });
    expect(strict.isError).toBe(true);
  });

  test("health is honest: every real provider can log in but none has a verified operation", async () => {
    const r = env(await client.callTool({ name: "social_system_health", arguments: { profile: "standard" } }));
    expect(r.data.components.vault.state).toBe("unlocked");
    const items = r.data.components.providers.items as { provider: string; oauth_verified: boolean; verified_operations: number; test_only: boolean }[];
    expect(items).toHaveLength(8);
    for (const p of items.filter((x) => !x.test_only)) {
      expect(p.oauth_verified, p.provider).toBe(true);
      expect(p.verified_operations, p.provider).toBe(0);
    }
    expect(items.find((x) => x.provider === "fixture")!.verified_operations).toBeGreaterThan(0);
  });

  test("resources and prompts are listed and readable", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("social://capabilities/providers");
    expect(uris).toContain("social://skills");
    expect(uris).toContain("social://operations/content.publish.text");
    expect(uris).toContain("social://policies/linkedin");
    const skills = await client.readResource({ uri: "social://skills" });
    expect(JSON.parse(String((skills.contents[0] as { text: string }).text))).toHaveLength(14);
    const card = await client.readResource({ uri: "social://operations/content.publish.text" });
    const providers = JSON.parse(String((card.contents[0] as { text: string }).text)).providers as { provider: string; verdict: string }[];
    expect(providers.find((p) => p.provider === "linkedin")?.verdict).toBe("UNVERIFIED");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([...CATALOG.prompts].sort());
  });

  test("diagnostics go to stderr only", () => {
    expect(stderr).toContain("xn-interact ready");
  });
});

describe("host capability detection", () => {
  test("the negotiated client identity and features are visible in health and the audit log", async () => {
    const r = env(await client.callTool({ name: "social_system_health", arguments: { profile: "standard" } }));
    const host = r.data.components.host;
    expect(host.client).toContain("contract-test");
    expect(host.features).toEqual({ elicitation: false, sampling: false, roots: false, tasks: false });
    expect(host.used).toContain("polling");
  });
});
