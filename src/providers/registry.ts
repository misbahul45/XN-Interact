import { PROVIDERS } from "../contracts/catalog.ts";
import { GatewayError } from "../contracts/errors.ts";
import type { ProviderAdapter } from "./contract.ts";
import { UnverifiedAdapter } from "./unverified.ts";

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(opts: { testAdapters?: ProviderAdapter[]; productionAdapters?: ProviderAdapter[]; allowTestAdapters?: boolean } = {}) {
    for (const p of PROVIDERS) this.adapters.set(p, new UnverifiedAdapter(p));
    for (const a of opts.productionAdapters ?? []) {
      if (!PROVIDERS.includes(a.manifest.provider)) throw new Error(`production adapter ${a.manifest.provider} is not a catalog provider`);
      this.adapters.set(a.manifest.provider, a);
    }
    for (const a of opts.testAdapters ?? []) {
      if (a.testOnly && !opts.allowTestAdapters) throw new Error(`test-only adapter ${a.manifest.provider} refused outside the test environment`);
      this.adapters.set(a.manifest.provider, a);
    }
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  get(provider: string): ProviderAdapter {
    const a = this.adapters.get(provider);
    if (!a) throw new GatewayError("UNSUPPORTED", `unknown provider ${provider}`);
    return a;
  }

  hostAllowlist(): Record<string, string[]> {
    return Object.fromEntries([...this.adapters].map(([k, a]) => [k, a.manifest.hosts]));
  }
}
