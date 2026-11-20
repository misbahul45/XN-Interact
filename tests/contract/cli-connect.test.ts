import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fixtureConsent } from "../../src/providers/fixture/adapter.ts";
import { ROOT, tempHome, testEnv } from "../helpers.ts";

function pump(stream: ReadableStream<Uint8Array>) {
  const state = { text: "" };
  const done = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of stream) state.text += dec.decode(chunk);
  })();
  return { state, done };
}

async function waitFor(state: { text: string }, pattern: RegExp, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pattern.test(state.text) && Date.now() < deadline) await Bun.sleep(50);
  expect(pattern.test(state.text)).toBe(true);
}

describe("xn-interact connect", () => {
  test("prints the consent URL, waits for the callback and reports the account without any token", async () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file", XN_INTERACT_FIXTURE_PROVIDER: "1", XN_INTERACT_FIXTURE_STATE: join(home, "remote.json") }), PATH: process.env.PATH ?? "" };
    const init = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "doctor"], { env });
    expect(init.exitCode).toBe(0);
    const proc = Bun.spawn([process.execPath, join(ROOT, "src/cli.ts"), "connect", "fixture"], { env, stdout: "pipe", stderr: "pipe" });
    const out = pump(proc.stdout);
    await waitFor(out.state, /waiting for your consent/);
    const head = out.state.text;
    const authUrl = /auth_url: (\S+)/.exec(head)![1]!;
    expect(head).toContain("scopes:");
    const c = fixtureConsent(authUrl);
    const cb = new URL(c.redirect_uri);
    cb.searchParams.set("code", c.code!);
    cb.searchParams.set("state", c.state);
    expect((await fetch(cb)).status).toBe(200);
    const code = await proc.exited;
    await out.done;
    const all = out.state.text;
    expect(code).toBe(0);
    expect(all).toContain('"status": "connected"');
    expect(all).toContain("Fixture Member");
    expect(all).not.toMatch(/fxt-access|fxt-refresh/);
  }, 60000);

  test("a provider whose app is not registered fails with the instruction and a non-zero exit", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" };
    Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "vault", "init"], { env });
    const r = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "connect", "linkedin"], { env });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("APP_APPROVAL_REQUIRED");
  });
});

describe("xn-interact login", () => {
  test("without app credentials it explains the three steps and, without a terminal, refuses to read secrets", () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file" }), PATH: process.env.PATH ?? "" };
    Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "vault", "init"], { env });
    const r = Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "login", "threads"], { env });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("interactive terminal");
  });

  test("with credentials already stored it goes straight to the consent step", async () => {
    const home = tempHome();
    const env = { ...testEnv(home, { XN_INTERACT_KEYRING: "file", XN_INTERACT_FIXTURE_PROVIDER: "1", XN_INTERACT_FIXTURE_STATE: join(home, "remote.json") }), PATH: process.env.PATH ?? "" };
    Bun.spawnSync([process.execPath, join(ROOT, "src/cli.ts"), "doctor"], { env });
    const proc = Bun.spawn([process.execPath, join(ROOT, "src/cli.ts"), "login", "fixture"], { env, stdout: "pipe", stderr: "pipe" });
    const out = pump(proc.stdout);
    await waitFor(out.state, /waiting for your consent/);
    expect(out.state.text).toContain("already stored");
    proc.kill();
  }, 60000);
});
