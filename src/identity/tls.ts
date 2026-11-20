import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayError } from "../contracts/errors.ts";

export interface TlsPair {
  cert: string;
  key: string;
}

export function ensureLoopbackCert(dir: string): TlsPair {
  const certPath = join(dir, "callback.crt");
  const keyPath = join(dir, "callback.key");
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = Bun.spawnSync(
      ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825", "-keyout", keyPath, "-out", certPath, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (r.exitCode !== 0) {
      throw new GatewayError("UNSUPPORTED", "could not create the local HTTPS certificate (openssl failed)", { actionable_next_step: "Install openssl, or register an HTTP loopback redirect where the provider allows it" });
    }
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o644);
  }
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}
