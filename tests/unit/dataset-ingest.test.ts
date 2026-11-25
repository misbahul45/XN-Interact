import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { queryInput } from "../../src/extraction/contracts.ts";
import { queryDataset } from "../../src/extraction/datasets.ts";
import { ingestOwnerExport } from "../../src/extraction/ingest.ts";
import { openApp } from "../helpers.ts";

function zip(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name);
  const input = Buffer.from(content);
  const crc = Bun.hash.crc32(input);
  const compressed = deflateRawSync(input);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(input.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(input.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, eocd]);
}

test("owner export ingestion projects an approved schema and excludes credentials and arbitrary files", async () => {
  const ctx = await openApp();
  try {
    const { extraction, config } = ctx.app;
    extraction.registerOwnerExport({ id: "owner-data", kind: "owner_export", provider: "linkedin",
      fields: [{ name: "title", type: "string" }, { name: "rank", type: "number" }] });
    const manifest = { source_id: "owner-data", provider: "linkedin", entity_type: "listing", fields: ["title", "rank"], identity_field: "rank" };
    expect(() => extraction.source("owner-data")).toThrow("limited to owner-provided exports");
    const csv = join(ctx.home, "records.csv");
    writeFileSync(csv, 'title,rank,password\r\n"Line\nTwo",1,fixture-test-secret\r\n"Line\nTwo",1,another-secret\r\n"password: fixture-test-secret",2,hidden\r\n');
    const result = ingestOwnerExport(config, extraction, csv, manifest);
    expect(result.execution.backend).toBe("owner_export");
    expect(result.coverage).toMatchObject({ unique_records: 2, duplicate_observations: 1 });
    const query = queryDataset(extraction, queryInput.parse({ dataset_ref: result.dataset_ref, sort: { field: "rank" } }));
    expect(query.items.map((item) => item.values)).toEqual([{ title: "Line Two", rank: 1 }, { title: null, rank: 2 }]);
    expect(JSON.stringify(query)).not.toContain("fixture-test-secret");
    expect(ingestOwnerExport(config, extraction, csv, manifest).dataset_ref).toBe(result.dataset_ref);

    const jsonl = join(ctx.home, "records.jsonl");
    writeFileSync(jsonl, '{"title":"Checked","rank":3}\n');
    expect(ingestOwnerExport(config, extraction, jsonl, manifest).coverage.unique_records).toBe(1);
    const json = join(ctx.home, "records.json");
    writeFileSync(json, '[{"title":"Checked","rank":4}]');
    expect(ingestOwnerExport(config, extraction, json, manifest).coverage.unique_records).toBe(1);
    const html = join(ctx.home, "records.html");
    writeFileSync(html, '<script>throw new Error("must stay inert")</script><table><tr><th>title</th><th>rank</th></tr><tr><td>HTML result</td><td>5</td></tr></table>');
    expect(ingestOwnerExport(config, extraction, html, manifest).coverage.unique_records).toBe(1);
    const archive = join(ctx.home, "archive.zip");
    writeFileSync(archive, zip("export/records.json", '[{"title":"ZIP result","rank":6}]'));
    const selectedArchive = { ...manifest, archive_member: "export/records.json" };
    expect(ingestOwnerExport(config, extraction, archive, selectedArchive).coverage.unique_records).toBe(1);
    expect(() => ingestOwnerExport(config, extraction, archive, manifest)).toThrow("explicitly selected");
    writeFileSync(archive, zip("../records.json", '[{"title":"Malicious path","rank":6}]'));
    expect(() => ingestOwnerExport(config, extraction, archive, { ...manifest, archive_member: "../records.json" })).toThrow("invalid");
    expect(() => ingestOwnerExport(config, extraction, archive, selectedArchive)).toThrow("invalid");
    const protectedDir = join(ctx.home, "browser");
    mkdirSync(protectedDir, { mode: 0o700 });
    const privateFile = join(protectedDir, "records.json");
    writeFileSync(privateFile, '[{"title":"Protected","rank":44}]');
    expect(() => ingestOwnerExport(config, extraction, privateFile, manifest)).toThrow("protected directories");
  } finally {
    ctx.app.close();
  }
});
