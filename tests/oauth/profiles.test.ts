import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import { pkceChallenge } from "../../src/identity/oauth-broker.ts";
import type { OAuthProfile } from "../../src/providers/contract.ts";
import { FixtureAdapter, FixtureRemote, fixtureConsent } from "../../src/providers/fixture/adapter.ts";
import { invoke } from "../../src/routing/gateway.ts";
import { tempHome, testEnv } from "../helpers.ts";

class Variant extends FixtureAdapter {
  constructor(name: string, patch: Partial<OAuthProfile>) {
    super(new FixtureRemote());
    this.manifest.provider = name;
    Object.assign(this.oauth, patch, { callback_path: `/oauth/callback/${name}` });
  }
}

let app: App;
afterEach(() => app?.close());

async function open(adapters: FixtureAdapter[]) {
  const home = tempHome();
  const clients = Object.fromEntries(adapters.map((a) => [a.manifest.provider, { client_id: "c" }]));
  app = await App.open(loadConfig(testEnv(home)), { keyring: new MemoryKeyring(new Map()), testAdapters: adapters, testClients: clients });
  return app;
}

describe("OAuth provider profile options", () => {
  test("PKCE challenge matches the RFC 7636 vector and the hex variant TikTok requires", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await pkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const hex = await pkceChallenge(verifier, "hex");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(hex, "hex").toString("base64url")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("a profile with hex encoding sends a hex challenge in the authorization URL", async () => {
    await open([new Variant("fixture_hex", { pkce_encoding: "hex" })]);
    const r = await invoke(app, "social_auth_connect", { provider: "fixture_hex" });
    expect(r.ok).toBe(true);
    expect(new URL((r.data as { auth_url: string }).auth_url).searchParams.get("code_challenge")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an HTTPS-only provider gets a local HTTPS redirect and completes login through it", async () => {
    await open([new Variant("fixture_https", { redirect: "https" })]);
    const start = await invoke(app, "social_auth_connect", { provider: "fixture_https" });
    expect(start.ok).toBe(true);
    const data = start.data as { auth_url: string; redirect_uri: string; warnings: string[] };
    expect(data.redirect_uri).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/fixture_https$/);
    expect(data.warnings.join(" ")).toContain("self-signed");
    const consent = fixtureConsent(data.auth_url);
    const cb = new URL(consent.redirect_uri);
    cb.searchParams.set("code", consent.code!);
    cb.searchParams.set("state", consent.state);
    const res = await fetch(cb, { tls: { rejectUnauthorized: false } } as RequestInit);
    expect(res.status).toBe(200);
    expect(app.accounts.list({ provider: "fixture_https" }).length).toBeGreaterThan(0);
  });

  test("the redirect mode can be forced from the command line without changing the provider profile", async () => {
    await open([new Variant("fixture_force", {})]);
    const https = await app.broker.start({ provider: "fixture_force", mode: "connect", redirect: "https" });
    expect(String(https.redirect_uri)).toMatch(/^https:/);
    const http = await app.broker.start({ provider: "fixture_force", mode: "connect", redirect: "loopback" });
    expect(String(http.redirect_uri)).toMatch(/^http:/);
  });
});
