import { GatewayError } from "../contracts/errors.ts";
import { redactor } from "../observability/redact.ts";
import { importKey, open, seal, sealedKeyVersion } from "../storage/encryption.ts";
import type { Keyring } from "./keyring.ts";

export type VaultState = "unlocked" | "uninitialized" | "locked";

const KEY_NAME = (v: number) => `vault-master-v${v}`;
const CURRENT = "vault-current";

export class Vault {
  private keys = new Map<number, CryptoKey>();
  private version = 0;
  state: VaultState = "locked";
  reason = "not opened";

  constructor(private readonly keyring: Keyring) {}

  get backend(): string {
    return this.keyring.backend;
  }

  async open(): Promise<VaultState> {
    try {
      const cur = await this.keyring.get(CURRENT);
      if (!cur) {
        this.state = "uninitialized";
        this.reason = "no vault key in the keyring; run `xn-interact vault init`";
        return this.state;
      }
      const v = Number.parseInt(cur, 10);
      for (let i = 1; i <= v; i++) {
        const b64 = await this.keyring.get(KEY_NAME(i));
        if (b64) this.keys.set(i, await importKey(Buffer.from(b64, "base64")));
      }
      if (!this.keys.has(v)) throw new Error(`key version ${v} missing from the keyring`);
      this.version = v;
      this.state = "unlocked";
      this.reason = "ok";
    } catch (e) {
      this.state = "locked";
      this.reason = `keyring unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
    return this.state;
  }

  private lastOpen = 0;

  async reopenIfDue(minIntervalMs = 5000): Promise<VaultState> {
    if (this.state === "unlocked" || Date.now() - this.lastOpen < minIntervalMs) return this.state;
    this.lastOpen = Date.now();
    return this.open();
  }

  async init(): Promise<{ created: boolean; version: number }> {
    if ((await this.open()) === "unlocked") return { created: false, version: this.version };
    if (this.state === "locked") throw new Error(this.reason);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    await this.keyring.set(KEY_NAME(1), Buffer.from(raw).toString("base64"));
    await this.keyring.set(CURRENT, "1");
    await this.open();
    return { created: true, version: 1 };
  }

  async rotate(): Promise<number> {
    this.require();
    const next = this.version + 1;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    await this.keyring.set(KEY_NAME(next), Buffer.from(raw).toString("base64"));
    await this.keyring.set(CURRENT, String(next));
    await this.open();
    return next;
  }

  require(): void {
    if (this.state !== "unlocked") {
      throw new GatewayError("VAULT_LOCKED", `vault is ${this.state}`, { actionable_next_step: this.state === "uninitialized" ? "Run `xn-interact vault init` in a terminal" : "Unlock the OS keyring (desktop session) and restart the host" });
    }
  }

  get keyVersion(): number {
    return this.version;
  }

  async seal(plaintext: string, aad: string): Promise<Uint8Array> {
    this.require();
    return seal(this.keys.get(this.version)!, this.version, plaintext, aad);
  }

  async open_(blob: Uint8Array, aad: string): Promise<string> {
    this.require();
    const key = this.keys.get(sealedKeyVersion(blob));
    if (!key) throw new GatewayError("VAULT_LOCKED", "ciphertext uses a key version that is not available");
    return open(key, blob, aad);
  }

  async sealJson(value: unknown, aad: string): Promise<Uint8Array> {
    return this.seal(JSON.stringify(value), aad);
  }

  async openJson<T>(blob: Uint8Array, aad: string, secretFields: string[] = []): Promise<T> {
    const v = JSON.parse(await this.open_(blob, aad)) as T;
    for (const f of secretFields) redactor.register((v as Record<string, unknown>)[f] as string | undefined);
    return v;
  }
}
