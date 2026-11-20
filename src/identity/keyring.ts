import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
export interface Keyring {
  readonly backend: "os" | "memory" | "file";
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export const KEYRING_SERVICE = "xn-interact";

export class OsKeyring implements Keyring {
  readonly backend = "os" as const;
  constructor(private readonly service = KEYRING_SERVICE) {}
  async get(name: string): Promise<string | null> {
    return Bun.secrets.get({ service: this.service, name });
  }
  async set(name: string, value: string): Promise<void> {
    await Bun.secrets.set({ service: this.service, name, value });
  }
  async delete(name: string): Promise<boolean> {
    return Bun.secrets.delete({ service: this.service, name });
  }
}

const shared = new Map<string, string>();

export class MemoryKeyring implements Keyring {
  readonly backend = "memory" as const;
  constructor(private readonly store: Map<string, string> = shared) {}
  async get(name: string): Promise<string | null> {
    return this.store.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.store.set(name, value);
  }
  async delete(name: string): Promise<boolean> {
    return this.store.delete(name);
  }
}

export class FileKeyring implements Keyring {
  readonly backend = "file" as const;
  constructor(private readonly path: string) {}
  private read(): Record<string, string> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>) : {};
  }
  private write(v: Record<string, string>): void {
    writeFileSync(this.path, JSON.stringify(v), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  async get(name: string): Promise<string | null> {
    return this.read()[name] ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.write({ ...this.read(), [name]: value });
  }
  async delete(name: string): Promise<boolean> {
    const v = this.read();
    const had = name in v;
    delete v[name];
    this.write(v);
    return had;
  }
}
