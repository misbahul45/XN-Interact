import { log } from "../observability/logger.ts";
import type { TlsPair } from "./tls.ts";

export type CallbackHandler = (provider: string, params: URLSearchParams) => Promise<{ ok: boolean; message: string }>;

const SIGNATURE = "xn-interact-oauth-callback";

export class CallbackListener {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private idleTimer: Timer | null = null;
  port = 0;
  external = false;

  readonly scheme: "http" | "https";

  constructor(private readonly requestedPort: number, private readonly handler: CallbackHandler, private readonly idleMs = 600_000, private readonly tls: TlsPair | null = null) {
    this.scheme = tls ? "https" : "http";
  }

  async ensure(): Promise<number> {
    if (this.server || this.external) {
      this.touch();
      return this.port;
    }
    try {
      this.server = Bun.serve({ hostname: "127.0.0.1", port: this.requestedPort, fetch: (req) => this.handle(req), ...(this.tls ? { tls: { cert: this.tls.cert, key: this.tls.key } } : {}) });
      this.port = this.server.port ?? this.requestedPort;
      this.touch();
      log.info("oauth callback listener started", { port: this.port, scheme: this.scheme });
    } catch (e) {
      if (this.requestedPort && (await this.peerListening(this.requestedPort))) {
        this.external = true;
        this.port = this.requestedPort;
        log.info("oauth callback served by another xn-interact process", { port: this.port });
      } else {
        throw e;
      }
    }
    return this.port;
  }

  private async peerListening(port: number): Promise<boolean> {
    try {
      const r = await fetch(`${this.scheme}://127.0.0.1:${port}/xn-interact/ping`, { signal: AbortSignal.timeout(1000), ...(this.tls ? { tls: { rejectUnauthorized: false } } : {}) } as RequestInit);
      return (await r.text()) === SIGNATURE;
    } catch {
      return false;
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.server) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.server?.stop(true);
    this.server = null;
    this.external = false;
  }

  private page(status: number, text: string): Response {
    const body = `<!doctype html><meta charset="utf-8"><title>XN-Interact</title><p>${text.replace(/[<>&"]/g, "")}</p>`;
    return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } });
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return new Response("forbidden", { status: 403 });
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    if (url.pathname === "/xn-interact/ping") return new Response(SIGNATURE);
    const m = /^\/oauth\/callback\/([a-z0-9_-]{1,32})$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    this.touch();
    try {
      const r = await this.handler(m[1]!, url.searchParams);
      return this.page(r.ok ? 200 : 400, r.message);
    } catch {
      return this.page(400, "Connection failed. Return to your MCP host for details.");
    }
  }
}
