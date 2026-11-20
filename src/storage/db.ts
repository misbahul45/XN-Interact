import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: Database;

  constructor(path: string) {
    const fresh = path !== ":memory:" && !existsSync(path);
    this.raw = new Database(path, { create: true, strict: true });
    if (fresh) chmodSync(path, 0o600);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 8000");
    this.raw.exec("PRAGMA synchronous = NORMAL");
  }

  tx<T>(fn: () => T): T {
    return this.raw.transaction(fn).immediate();
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | null {
    return (this.raw.query(sql).get(...(params as never[])) as T | null) ?? null;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.query(sql).all(...(params as never[])) as T[];
  }

  run(sql: string, ...params: unknown[]): { changes: number } {
    const r = this.raw.query(sql).run(...(params as never[]));
    return { changes: r.changes };
  }

  close(): void {
    this.raw.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Buffer.from(bytes).toString("base64url")}`;
}

export function jsonOr<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
