import { join } from "node:path";
import { type Config, ensureHome } from "./bootstrap/config.ts";
import { Drafts } from "./content/drafts.ts";
import { MediaSandbox } from "./content/media.ts";
import { AccountRegistry } from "./identity/account-registry.ts";
import { AppSecrets } from "./identity/app-secrets.ts";
import { CallbackListener } from "./identity/callback-listener.ts";
import { ensureLoopbackCert } from "./identity/tls.ts";
import { FileKeyring, type Keyring, MemoryKeyring, OsKeyring } from "./identity/keyring.ts";
import { OAuthBroker } from "./identity/oauth-broker.ts";
import { TokenManager } from "./identity/token-manager.ts";
import { Vault } from "./identity/vault.ts";
import { Audit } from "./observability/audit.ts";
import { log } from "./observability/logger.ts";
import { Results } from "./performance/results.ts";
import { Approvals } from "./policy/approvals.ts";
import { Acceptance } from "./policy/acceptance.ts";
import { Grants } from "./policy/grants.ts";
import { Signoffs } from "./policy/signoffs.ts";
import { Budget } from "./policy/budget.ts";
import { CapabilityResolver } from "./policy/capability-resolver.ts";
import type { ClientCredentials, ProviderAdapter } from "./providers/contract.ts";
import { FixtureAdapter, FixtureRemote } from "./providers/fixture/adapter.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import type { HttpHolder } from "./providers/base.ts";
import { FacebookAdapter } from "./providers/facebook/adapter.ts";
import { InstagramAdapter } from "./providers/instagram/adapter.ts";
import { LinkedInAdapter } from "./providers/linkedin/adapter.ts";
import { RedditAdapter } from "./providers/reddit/adapter.ts";
import { ThreadsAdapter } from "./providers/threads/adapter.ts";
import { TikTokAdapter } from "./providers/tiktok/adapter.ts";
import { XAdapter } from "./providers/x/adapter.ts";
import { Plans } from "./routing/plans.ts";
import { SkillRegistry } from "./routing/skill-registry.ts";
import { Db } from "./storage/db.ts";
import { migrate } from "./storage/migrations.ts";
import { purge } from "./storage/retention.ts";
import { ProviderHttp } from "./transport/provider-http.ts";
import { WorkflowEngine } from "./workflow/engine.ts";
import { Leases } from "./workflow/leases.ts";

export interface AppOptions {
  keyring?: Keyring;
  testAdapters?: ProviderAdapter[];
  testClients?: Record<string, ClientCredentials>;
  fetchImpl?: typeof fetch;
}

export class App {
  readonly db: Db;
  readonly keyring: Keyring;
  readonly vault: Vault;
  readonly audit: Audit;
  readonly providers: ProviderRegistry;
  readonly http: ProviderHttp;
  readonly accounts: AccountRegistry;
  readonly apps: AppSecrets;
  readonly tokens: TokenManager;
  readonly broker: OAuthBroker;
  readonly listener: CallbackListener;
  readonly budget: Budget;
  readonly acceptance: Acceptance;
  readonly grants: Grants;
  readonly signoffs: Signoffs;
  readonly resolver: CapabilityResolver;
  readonly media: MediaSandbox;
  readonly drafts: Drafts;
  readonly plans: Plans;
  readonly approvals: Approvals;
  readonly results: Results;
  readonly leases: Leases;
  readonly engine: WorkflowEngine;
  readonly skills: SkillRegistry;
  readonly migrations: string[];
  host: { name: string; version: string; capabilities: string[]; protocol_features: Record<string, boolean> } | null = null;
  private tlsListenerRef: CallbackListener | null = null;
  private ticker: Timer | null = null;
  private retention: Timer | null = null;

  private constructor(readonly config: Config, opts: AppOptions) {
    ensureHome(config);
    this.db = new Db(config.dbPath);
    this.migrations = migrate(this.db, config.dbPath).current;
    this.keyring = opts.keyring ?? (config.keyring === "memory" ? new MemoryKeyring() : config.keyring === "file" ? new FileKeyring(join(config.home, "test-keyring.json")) : new OsKeyring());
    this.vault = new Vault(this.keyring);
    this.audit = new Audit(this.db);
    const testAdapters = [...(opts.testAdapters ?? [])];
    const testClients = { ...(opts.testClients ?? {}) };
    if (config.fixtureProvider) {
      testAdapters.push(new FixtureAdapter(new FixtureRemote(process.env.XN_INTERACT_FIXTURE_STATE ?? join(config.home, "fixture-remote.json"))));
      testClients.fixture = { client_id: "fixture-client" };
    }
    const holder: HttpHolder = { http: null };
    this.providers = new ProviderRegistry({ testAdapters, productionAdapters: [new LinkedInAdapter(holder), new InstagramAdapter(holder, { publicMediaBase: config.publicMediaBase }), new TikTokAdapter(holder), new XAdapter(holder), new ThreadsAdapter(holder), new RedditAdapter(holder), new FacebookAdapter(holder)], allowTestAdapters: config.env === "test" });
    this.http = new ProviderHttp(this.providers.hostAllowlist(), { fetchImpl: opts.fetchImpl, allowLoopbackHttp: config.env === "test" });
    holder.http = this.http;
    this.accounts = new AccountRegistry(this.db, this.vault);
    this.apps = new AppSecrets(this.keyring, this.db, config.env === "test" ? testClients : {});
    this.leases = new Leases(this.db, config.processId);
    this.tokens = new TokenManager(this.accounts, this.providers, (p) => this.apps.lookup(p), this.leases);
    this.broker = new OAuthBroker(this.db, this.vault, this.providers, this.accounts, this.apps, this.audit);
    this.listener = new CallbackListener(config.callbackPort, (p, q) => this.broker.handleCallback(p, q));
    this.broker.listener = this.listener;
    this.broker.redirectMode = config.redirectMode;
    let tlsListener: CallbackListener | null = null;
    this.broker.tlsListener = () => {
      tlsListener ??= new CallbackListener(config.httpsPort, (p, q) => this.broker.handleCallback(p, q), 600_000, ensureLoopbackCert(join(config.home, "tls")));
      this.tlsListenerRef = tlsListener;
      return tlsListener;
    };
    this.budget = new Budget(this.db);
    this.acceptance = new Acceptance(this.db);
    this.grants = new Grants(this.db);
    this.signoffs = new Signoffs(this.db);
    this.resolver = new CapabilityResolver(this.db, this.providers, this.accounts, this.apps, this.budget, undefined, undefined, this.acceptance, this.signoffs);
    this.media = new MediaSandbox(this.db, config.mediaRoots, config.mediaDir);
    this.drafts = new Drafts(this.db, this.media);
    this.plans = new Plans(this.db);
    this.approvals = new Approvals(this.db);
    this.results = new Results(this.db, this.vault);
    this.engine = new WorkflowEngine({
      db: this.db, providers: this.providers, accounts: this.accounts, tokens: this.tokens, apps: this.apps, budget: this.budget,
      resolver: this.resolver, results: this.results, audit: this.audit, leases: this.leases, http: this.http, acceptance: this.acceptance,
    });
    this.skills = new SkillRegistry();
  }

  static async open(config: Config, opts: AppOptions = {}): Promise<App> {
    const app = new App(config, opts);
    await app.vault.open();
    if (app.vault.state === "uninitialized" && app.keyring.backend !== "os" && config.env === "test") await app.vault.init();
    return app;
  }

  startTicker(): void {
    if (this.ticker) return;
    const recovered = this.engine.recover();
    if (recovered.runs.length) log.info("workflow recovery", recovered);
    if (this.config.tickMs <= 0) return;
    this.ticker = setInterval(() => {
      this.engine.tick().catch((e) => log.error("workflow tick failed", { error: e instanceof Error ? e.message : String(e) }));
      this.results.prune();
    }, this.config.tickMs);
    this.retention = setInterval(() => {
      try {
        purge(this.db, this.config.mediaDir);
      } catch (e) {
        log.error("retention failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }, 3_600_000);
    (this.retention as unknown as { unref?: () => void }).unref?.();
    (this.ticker as unknown as { unref?: () => void }).unref?.();
  }

  tickerActive(): boolean {
    return this.ticker !== null;
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.retention) clearInterval(this.retention);
    this.ticker = null;
    this.retention = null;
    this.listener.stop();
    this.tlsListenerRef?.stop();
    this.leases.releaseAll();
    this.db.close();
  }
}
