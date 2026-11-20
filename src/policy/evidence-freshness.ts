import { evidenceRow } from "../providers/unverified.ts";

export const MAX_EVIDENCE_AGE_DAYS = 90;
export const TIMEZONE_SKEW_MS = 14 * 3600_000;

export interface EvidenceDate {
  verified_date: string | null;
}

export type EvidenceLookup = (provider: string) => EvidenceDate | undefined;

export function evidenceIsFresh(date: string | null | undefined, now = Date.now(), maxDays = MAX_EVIDENCE_AGE_DAYS): boolean {
  if (!date) return false;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return false;
  return t <= now + TIMEZONE_SKEW_MS && now - t <= maxDays * 86_400_000;
}

export const defaultEvidenceLookup: EvidenceLookup = (provider) => evidenceRow(provider);
