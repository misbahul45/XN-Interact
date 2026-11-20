const VERSION = 1;

export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("vault key must be 32 bytes");
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, keyVersion: number, plaintext: string, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(2 + iv.length + ct.length);
  out[0] = VERSION;
  out[1] = keyVersion;
  out.set(iv, 2);
  out.set(ct, 14);
  return out;
}

export function sealedKeyVersion(blob: Uint8Array): number {
  return blob[1] ?? 0;
}

export async function open(key: CryptoKey, blob: Uint8Array, aad: string): Promise<string> {
  if (blob[0] !== VERSION) throw new Error("unsupported ciphertext version");
  const iv = new Uint8Array(blob.slice(2, 14));
  const ct = new Uint8Array(blob.slice(14));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, ct);
  return new TextDecoder().decode(pt);
}
