import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/contracts/errors.ts";
import { ProviderHttp } from "../../src/transport/provider-http.ts";

const ok = (status: number, body = "{}", headers: Record<string, string> = {}) => new Response(body, { status, headers });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (e) {
    return e instanceof GatewayError ? e.code : "other";
  }
}

describe("provider transport", () => {
  test("refuses non-https, foreign hosts and credentials in URLs", async () => {
    const http = new ProviderHttp({ p: ["api.p.example"] }, { fetchImpl: (async () => ok(200)) as unknown as typeof fetch });
    expect(await code(http.request("p", { method: "GET", url: "http://api.p.example/x", safe: true }))).toBe("PROHIBITED");
    expect(await code(http.request("p", { method: "GET", url: "https://169.254.169.254/latest", safe: true }))).toBe("PROHIBITED");
    expect(await code(http.request("p", { method: "GET", url: "https://user:pw@api.p.example/x", safe: true }))).toBe("PROHIBITED");
    expect(await code(http.request("q", { method: "GET", url: "https://api.p.example/x", safe: true }))).toBe("PROHIBITED");
  });

  test("retries safe reads on 5xx, never retries writes, maps 429 and lost writes", async () => {
    let calls = 0;
    const flaky = (async () => (++calls < 3 ? ok(503) : ok(200, '{"a":1}'))) as unknown as typeof fetch;
    const http = new ProviderHttp({ p: ["api.p.example"] }, { fetchImpl: flaky });
    const r = await http.request("p", { method: "GET", url: "https://api.p.example/x", safe: true });
    expect(r.json()).toEqual({ a: 1 });
    expect(calls).toBe(3);
    let writes = 0;
    const down = (async () => {
      writes++;
      throw new TypeError("socket hang up");
    }) as unknown as typeof fetch;
    const w = new ProviderHttp({ p: ["api.p.example"] }, { fetchImpl: down });
    expect(await code(w.request("p", { method: "POST", url: "https://api.p.example/post", safe: false }))).toBe("OUTCOME_UNKNOWN");
    expect(writes).toBe(1);
    const limited = new ProviderHttp({ p: ["api.p.example"] }, { fetchImpl: (async () => ok(429, "", { "retry-after": "7" })) as unknown as typeof fetch });
    try {
      await limited.request("p", { method: "GET", url: "https://api.p.example/x", safe: true });
    } catch (e) {
      expect((e as GatewayError).code).toBe("RATE_LIMITED");
      expect((e as GatewayError).extras.retry_after_ms).toBe(7000);
    }
    const redirect = new ProviderHttp({ p: ["api.p.example"] }, { fetchImpl: (async () => ok(302, "", { location: "https://evil.example" })) as unknown as typeof fetch });
    expect(await code(redirect.request("p", { method: "GET", url: "https://api.p.example/x", safe: true }))).toBe("INVALID_PROVIDER_RESPONSE");
  });
});
