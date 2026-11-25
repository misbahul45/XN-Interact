import { inflateRawSync } from "node:zlib";
import { GatewayError } from "../contracts/errors.ts";

const invalid = () => new GatewayError("VALIDATION_FAILED", "ZIP structure or member is invalid or outside the import limits");

function safeName(name: string) {
  const components = name.replace(/\/$/, "").split("/");
  if (!name || name.length > 240 || /[\\:\x00-\x1f\x7f]/.test(name) ||
      components.some((part) => !part || part === "." || part === "..")) throw invalid();
}

export function readZipMember(bytes: Buffer, target: string, maxOutput: number): Buffer {
  safeName(target);
  if (target.endsWith("/")) throw invalid();
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65_535);
  while (end >= earliest && (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
  if (end < earliest || bytes.readUInt32LE(end + 4) !== 0) throw invalid();
  const entries = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  const centralSize = bytes.readUInt32LE(end + 12);
  if (!entries || entries > 512 || bytes.readUInt16LE(end + 8) !== entries || start + centralSize !== end) throw invalid();
  let pos = start;
  let total = 0;
  const seen = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let selected: { start: number; length: number; size: number; method: number; crc: number } | null = null;
  for (let index = 0; index < entries; index++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(pos + 8);
    const method = bytes.readUInt16LE(pos + 10);
    const crc = bytes.readUInt32LE(pos + 16);
    const compressed = bytes.readUInt32LE(pos + 20);
    const size = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28);
    const extraLength = bytes.readUInt16LE(pos + 30);
    const commentLength = bytes.readUInt16LE(pos + 32);
    const fileMode = bytes.readUInt32LE(pos + 38) >>> 28;
    const local = bytes.readUInt32LE(pos + 42);
    const nameStart = pos + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    total += size;
    if (next > end || bytes.readUInt16LE(pos + 34) !== 0 || (flags & 0x2041) || ![0, 8].includes(method) ||
        ![0, 4, 8].includes(fileMode) || total > maxOutput * 3 || size > maxOutput || size > compressed * 1000 + 1024 ||
        local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decoder.decode(nameBytes);
    safeName(name);
    if (seen.has(name)) throw invalid();
    seen.add(name);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const data = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (localNameLength !== nameLength || !nameBytes.equals(bytes.subarray(local + 30, local + 30 + localNameLength)) ||
        bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || data + compressed > start) throw invalid();
    if (name === target) selected = { start: data, length: compressed, size, method, crc };
    pos = next;
  }
  if (pos !== end || !selected) throw invalid();
  const raw = bytes.subarray(selected.start, selected.start + selected.length);
  let expanded: Buffer;
  try {
    expanded = selected.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, selected.size) });
  } catch {
    throw invalid();
  }
  if (expanded.length !== selected.size || Bun.hash.crc32(expanded) !== selected.crc) throw invalid();
  return expanded;
}
