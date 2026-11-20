import type { Db } from "../storage/db.ts";

export const LEASE_MS = 30_000;

export class Leases {
  constructor(private readonly db: Db, readonly owner: string) {}

  acquire(name: string, ms = LEASE_MS): boolean {
    return this.db.tx(() => {
      const row = this.db.get<{ owner: string; expires_at: string }>("SELECT owner, expires_at FROM worker_leases WHERE name = ?", name);
      if (row && row.owner !== this.owner && Date.parse(row.expires_at) > Date.now()) return false;
      this.db.run("INSERT INTO worker_leases(name, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at",
        name, this.owner, new Date(Date.now() + ms).toISOString());
      return true;
    });
  }

  heldByOther(name: string): boolean {
    const row = this.db.get<{ owner: string; expires_at: string }>("SELECT owner, expires_at FROM worker_leases WHERE name = ?", name);
    return Boolean(row && row.owner !== this.owner && Date.parse(row.expires_at) > Date.now());
  }

  release(name: string): void {
    this.db.run("DELETE FROM worker_leases WHERE name = ? AND owner = ?", name, this.owner);
  }

  releaseAll(): void {
    this.db.run("DELETE FROM worker_leases WHERE owner = ?", this.owner);
  }

}
