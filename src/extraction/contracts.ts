import * as z from "zod/v4";
import { PROVIDERS } from "../contracts/catalog.ts";
import { GatewayError } from "../contracts/errors.ts";

export const sourceId = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
export const runId = z.string().regex(/^ext_[A-Za-z0-9_-]{16}$/);
const sensitive = /pass(word|phrase|code)?|secret|token|cookie|credential|authorization|session|otp|mfa|api.?key|private|e.?mail|phone|contact|address|birth|ssn|identity|message|__proto__|constructor|prototype/i;
export const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,35}(\.[a-z][a-z0-9_]{0,35}){0,2}$/).refine((name) => !sensitive.test(name), "field is outside the data policy");
const fieldType = z.enum(["string", "number", "boolean", "date", "url", "array"]);
const field = z.strictObject({ name: fieldName, type: fieldType, required: z.boolean().default(false) });
const distinct = (fields: { name: string }[]) => new Set(fields.map((f) => f.name)).size === fields.length;

export const sourceSchema = z.strictObject({
  id: sourceId,
  url: z.url().max(512),
  path_prefix: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/).max(180),
  login_url: z.url().max(512).optional(),
  account_marker: z.string().regex(/^@?[a-zA-Z0-9_.-]{1,99}$/).optional(),
  permission: z.enum(["owner_controlled", "documented_permission"]),
  policy_url: z.url().max(512).optional(),
  layout: z.enum(["annotated", "table"]).default("annotated"),
  mechanism: z.enum(["static", "next", "load_more", "scroll"]).default("static"),
  authoritative_total: z.boolean().default(false),
  fields: z.array(field.extend({ detail: z.boolean().default(false) })).min(1).max(24).refine(distinct),
}).refine((s) => s.permission === "owner_controlled" || s.policy_url !== undefined, "a permission source is required");
export type Source = z.output<typeof sourceSchema>;
export const exportSourceSchema = z.strictObject({
  id: sourceId,
  kind: z.literal("owner_export"),
  provider: z.string().refine((provider) => provider === "generic" || PROVIDERS.includes(provider)),
  fields: z.array(field).min(1).max(24).refine(distinct),
});
const predicate = z.strictObject({ field: fieldName, equals: z.union([z.string().max(160), z.number(), z.boolean()]) });
const maxRecords = z.number().int().min(1).max(25_000);

export const extractInput = z.strictObject({
  request_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  sources: z.array(sourceId).min(1).max(8).refine((ids) => new Set(ids).size === ids.length),
  objective: z.string().min(1).max(256),
  entity_type: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  fields: z.array(field).min(1).max(24).refine(distinct),
  filters: z.array(predicate).max(8).default([]),
  date_range: z.strictObject({ field: fieldName, from: z.iso.date().optional(), to: z.iso.date().optional() }).optional(),
  coverage: z.enum(["sample", "bounded", "all_accessible"]),
  detail_level: z.enum(["summary", "standard", "full"]).default("standard"),
  budget: z.strictObject({
    max_records: maxRecords.default(5_000),
    max_pages: z.number().int().min(1).max(250).default(100),
    max_duration_ms: z.number().int().min(1000).max(900_000).default(180_000),
    max_storage_bytes: z.number().int().min(1024).max(52_428_800).default(16_777_216),
    max_detail_pages: z.number().int().min(0).max(500).default(100),
  }).prefault({}),
  previous_dataset_ref: runId.optional(),
});
export type ExtractRequest = z.output<typeof extractInput>;
export const queryInput = z.strictObject({
  dataset_ref: runId,
  fields: z.array(fieldName).min(1).max(24).optional(),
  filter: predicate.optional(),
  sort: z.strictObject({ field: fieldName, direction: z.enum(["asc", "desc"]).default("asc") }).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(25_000).default(0),
});
export const exportInput = z.strictObject({ dataset_ref: runId, format: z.enum(["json", "jsonl", "csv", "sqlite"]) });

const providerDomains = ["linkedin.com", "instagram.com", "facebook.com", "tiktok.com", "threads.com", "threads.net", "x.com", "twitter.com", "reddit.com"];
export function assertSourceUrl(raw: string, test = false): URL {
  const url = new URL(raw);
  const loopback = test && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((!loopback && (url.protocol !== "https:" || url.port || !url.hostname.includes(".") || !/[a-z]$/i.test(url.hostname))) ||
    url.username || url.password || url.hash || providerDomains.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new GatewayError("PROHIBITED", "source origin is outside the browser collection policy");
  }
  return url;
}

export function inScope(source: Source, raw: string): boolean {
  try {
    const url = new URL(raw);
    const prefix = source.path_prefix.replace(/\/$/, "");
    return url.origin === new URL(source.url).origin && !url.username && !url.password &&
      !url.hash &&
      !/%(?:2f|5c|2e|00)|\\/i.test(url.pathname) &&
      (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) &&
      [...url.searchParams].every(([key, value]) =>
        /^(page|offset|start)$/.test(key) ? /^\d{1,8}$/.test(value) : /^(category|sort)$/.test(key) && /^[\w-]{1,32}$/.test(value));
  } catch {
    return false;
  }
}

export function publicUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol) || sensitive.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`.slice(0, 512);
  } catch {
    return null;
  }
}
