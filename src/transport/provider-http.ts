import { GatewayError } from "../contracts/errors.ts";

export interface HttpRequest {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams | Uint8Array;
  safe: boolean;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json<T = unknown>(): T;
}

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class ProviderHttp {
  private readonly gates = new Map<string, Semaphore>();

  constructor(
    private readonly allow: Record<string, string[]>,
    private readonly opts: { concurrency?: number; maxRetries?: number; allowLoopbackHttp?: boolean; fetchImpl?: typeof fetch } = {},
  ) {}

  assertAllowed(provider: string, url: string): URL {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new GatewayError("VALIDATION_FAILED", "invalid provider URL");
    }
    const loopback = this.opts.allowLoopbackHttp && u.protocol === "http:" && u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !loopback) throw new GatewayError("PROHIBITED", "provider calls must use https", { provider });
    if (u.username || u.password) throw new GatewayError("PROHIBITED", "credentials in URLs are refused", { provider });
    const hosts = this.allow[provider] ?? [];
    if (!hosts.includes(u.host)) throw new GatewayError("PROHIBITED", `host ${u.host} is not on the ${provider} allowlist`, { provider });
    return u;
  }

  async request(provider: string, req: HttpRequest): Promise<HttpResponse> {
    const u = this.assertAllowed(provider, req.url);
    const gate = this.gates.get(provider) ?? new Semaphore(this.opts.concurrency ?? 4);
    this.gates.set(provider, gate);
    const fetcher = this.opts.fetchImpl ?? fetch;
    const body = req.body instanceof Uint8Array ? new Uint8Array(req.body) : req.body;
    const maxRetries = req.safe ? (this.opts.maxRetries ?? 2) : 0;
    let attempt = 0;
    for (;;) {
      try {
        const res = await gate.run(() =>
          fetcher(u, { method: req.method, headers: req.headers, body, redirect: "manual", signal: AbortSignal.timeout(req.timeoutMs ?? 15000) }),
        );
        const text = await res.text();
        if (res.status >= 300 && res.status < 400) throw new GatewayError("INVALID_PROVIDER_RESPONSE", "provider redirected; redirects are not followed", { provider, provider_status: res.status });
        if (res.status === 429) {
          const ra = Number.parseFloat(res.headers.get("retry-after") ?? "");
          throw new GatewayError("RATE_LIMITED", "provider rate limit", { provider, provider_status: 429, retry_after_ms: Number.isFinite(ra) ? ra * 1000 : 60000 });
        }
        if (res.status >= 500 && attempt < maxRetries) {
          attempt++;
          await Bun.sleep(200 * 2 ** attempt);
          continue;
        }
        return {
          status: res.status,
          headers: res.headers,
          text,
          json<T>() {
            try {
              return JSON.parse(text) as T;
            } catch {
              throw new GatewayError("INVALID_PROVIDER_RESPONSE", "provider returned invalid JSON", { provider, provider_status: res.status });
            }
          },
        };
      } catch (e) {
        if (e instanceof GatewayError) throw e;
        if (req.safe && attempt < maxRetries) {
          attempt++;
          await Bun.sleep(200 * 2 ** attempt);
          continue;
        }
        if (req.safe) throw new GatewayError("PROVIDER_UNAVAILABLE", "provider unreachable", { provider });
        throw new GatewayError("OUTCOME_UNKNOWN", "provider did not answer a write; the outcome is unknown and will not be retried", { provider });
      }
    }
  }
}
