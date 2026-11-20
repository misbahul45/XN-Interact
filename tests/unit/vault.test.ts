import { describe, expect, test } from "bun:test";
import { MemoryKeyring, type Keyring } from "../../src/identity/keyring.ts";
import { Vault } from "../../src/identity/vault.ts";

class BrokenKeyring implements Keyring {
  readonly backend = "os" as const;
  async get(): Promise<string | null> {
    throw new Error("Cannot autolaunch D-Bus without X11 $DISPLAY");
  }
  async set(): Promise<void> {
    throw new Error("no bus");
  }
  async delete(): Promise<boolean> {
    throw new Error("no bus");
  }
}

describe("vault", () => {
  test("authenticated encryption bound to its AAD", async () => {
    const v = new Vault(new MemoryKeyring(new Map()));
    await v.init();
    const blob = await v.seal("secret-value", "grant|a");
    expect(Buffer.from(blob).toString("latin1")).not.toContain("secret-value");
    expect(await v.open_(blob, "grant|a")).toBe("secret-value");
    expect(v.open_(blob, "grant|b")).rejects.toThrow();
  });

  test("rotation keeps old ciphertext readable", async () => {
    const v = new Vault(new MemoryKeyring(new Map()));
    await v.init();
    const old = await v.seal("one", "x");
    expect(await v.rotate()).toBe(2);
    expect(await v.open_(old, "x")).toBe("one");
    expect((await v.seal("two", "x"))[1]).toBe(2);
  });

  test("an unavailable keyring locks the vault instead of falling back to plaintext", async () => {
    const v = new Vault(new BrokenKeyring());
    expect(await v.open()).toBe("locked");
    expect(v.seal("x", "y")).rejects.toMatchObject({ code: "VAULT_LOCKED" });
    const fresh = new Vault(new MemoryKeyring(new Map()));
    expect(await fresh.open()).toBe("uninitialized");
    expect(() => fresh.require()).toThrow();
  });
});

describe("vault reopening", () => {
  test("a vault initialized after start is picked up without a restart", async () => {
    const store = new Map<string, string>();
    const running = new Vault(new MemoryKeyring(store));
    expect(await running.open()).toBe("uninitialized");
    await new Vault(new MemoryKeyring(store)).init();
    expect(await running.reopenIfDue(0)).toBe("unlocked");
  });
});
