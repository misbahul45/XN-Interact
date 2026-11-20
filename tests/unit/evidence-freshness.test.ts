import { afterEach, describe, expect, test } from "bun:test";
import { App } from "../../src/app.ts";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { MemoryKeyring } from "../../src/identity/keyring.ts";
import { CapabilityResolver } from "../../src/policy/capability-resolver.ts";
import { evidenceIsFresh } from "../../src/policy/evidence-freshness.ts";
import { FixtureAdapter, FixtureRemote } from "../../src/providers/fixture/adapter.ts";
import { fixtureConsent } from "../../src/providers/fixture/adapter.ts";
import { tempHome, testEnv } from "../helpers.ts";
import { invoke } from "../../src/routing/gateway.ts";

const DAY = 86_400_000;
let app: App;
afterEach(() => app?.close());

class ProdLike extends FixtureAdapter {
  constructor() {
    super(new FixtureRemote());
    Object.defineProperty(this, "testOnly", { value: false });
    this.manifest.provider = "prodlike";
    this.oauth.callback_path = "/oauth/callback/prodlike";
  }
}

async function setup() {
  app = await App.open(loadConfig(testEnv(tempHome())), { keyring: new MemoryKeyring(new Map()), testAdapters: [new ProdLike()], testClients: { prodlike: { client_id: "c" } } });
  const start = await invoke(app, "social_auth_connect", { provider: "prodlike" });
  const c = fixtureConsent((start.data as { auth_url: string }).auth_url);
  const u = new URL(c.redirect_uri);
  u.searchParams.set("code", c.code!);
  u.searchParams.set("state", c.state);
  await fetch(u);
  return app.accounts.list({ provider: "prodlike" })[0]!.id;
}

describe("evidence freshness gate", () => {
  test("the pure rule: missing, invalid, future and old dates are stale", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    expect(evidenceIsFresh("2026-11-01", now)).toBe(true);
    expect(evidenceIsFresh(null, now)).toBe(false);
    expect(evidenceIsFresh("not a date", now)).toBe(false);
    expect(evidenceIsFresh("2026-12-01", now)).toBe(false);
    expect(evidenceIsFresh("2026-08-01", now)).toBe(false);
  });

  test("a date written in a timezone ahead of UTC is not 'the future': up to 14 hours of skew is accepted, two days is not", () => {
    const utcEvening = Date.parse("2026-11-19T20:21:00Z");
    expect(evidenceIsFresh("2026-11-20", utcEvening)).toBe(true);
    expect(evidenceIsFresh("2026-11-21", utcEvening)).toBe(false);
  });

  test("a production adapter's VERIFIED operation is demoted to UNVERIFIED when its evidence is missing or old, and recovers when refreshed", async () => {
    const id = await setup();
    let date: string | null = null;
    let now = Date.now();
    const resolver = new CapabilityResolver(app.db, app.providers, app.accounts, app.apps, app.budget, () => ({ verified_date: date }), () => now);
    expect(resolver.resolve(id, "content.read").state).toBe("UNVERIFIED");
    expect(resolver.resolve(id, "content.read").reason).toContain("older than 90 days");
    date = new Date(now - 10 * DAY).toISOString();
    expect(resolver.resolve(id, "content.read").state).toBe("AVAILABLE");
    now += 100 * DAY;
    expect(resolver.resolve(id, "content.read").state).toBe("UNVERIFIED");
    date = new Date(now - DAY).toISOString();
    expect(resolver.resolve(id, "content.read").state).toBe("AVAILABLE");
  });

  test("test-only adapters are exempt, and local operations never depend on evidence", async () => {
    const id = await setup();
    const resolver = new CapabilityResolver(app.db, app.providers, app.accounts, app.apps, app.budget, () => undefined);
    expect(resolver.resolve(id, "content.draft").state).toBe("AVAILABLE");
  });
});
