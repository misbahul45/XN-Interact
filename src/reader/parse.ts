
export interface JobCard {
  title: string;
  company: string | null;
  location: string | null;
  posted: string | null;
  easy_apply: boolean;
}

export interface FeedPost {
  source_company: string | null;
  age: string | null;
  promoted: boolean;
  keywords: string[];
  excerpt: string;
}

const ATTRS = /\s\[[^\]]*\]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function strip(line: string): string {
  return line.replace(ATTRS, "");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function clean(s: string, max: number): string {
  return s.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function unwrap(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

export function redactContact(s: string): string {
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]").replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}

const NOISE = /^(Posted\b|Actively reviewing|Be an early applicant|Easy Apply$|·$|Promoted$|Viewed$|\d+\s+(school alumni|connections?|people)\b|\d+[hdwmy]\b|\d+\s+\w+\s+ago$)/i;

export interface JobsParse {
  total: number | null;
  cards: JobCard[];
}

export function parseLinkedInJobs(aria: string, max: number): JobsParse {
  const lines = aria.split("\n").map(strip);
  const total = (() => {
    for (const l of lines) {
      const m = /^\s*- paragraph: (\d[\d,]*)\+?\s+results?$/.exec(l);
      if (m) return Number(m[1]!.replace(/,/g, ""));
    }
    return null;
  })();
  const cards: JobCard[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && cards.length < max; i++) {
    const m = /^(\s*)- button "(.+?) Dismiss (.+?) job(?: ([^"]*))?"/.exec(lines[i]!);
    if (!m) continue;
    const base = m[1]!.length;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "") continue;
      if (indentOf(l) <= base) break;
      block.push(l);
    }
    let title = m[3]!;
    for (const l of block) {
      const t = /^\s*- button "Dismiss (.+) job"/.exec(l);
      if (t) {
        title = t[1]!;
        break;
      }
    }
    title = clean(title, 160);
    const inline = block
      .map((l) => /^\s*- paragraph: (.+)$/.exec(l)?.[1])
      .filter((v): v is string => typeof v === "string")
      .map((v) => clean(unwrap(v), 160))
      .filter((v) => v !== "" && v !== title && !NOISE.test(v));
    const label = `${m[2]!} ${m[4] ?? ""}`;
    const posted = /Posted (\d+\s+\w+\s+ago)/.exec(`${label} ${block.join(" ")}`)?.[1] ?? block.map((l) => /^\s*- text: (\d+\s+\w+\s+ago)$/.exec(l)?.[1]).find(Boolean) ?? null;
    const card: JobCard = {
      title,
      company: inline[0] ?? null,
      location: inline[1] ?? null,
      posted,
      easy_apply: /\bEasy Apply\b/.test(`${m[4] ?? ""} ${block.join(" ")}`),
    };
    const key = `${card.title}|${card.company}`;
    if (!card.title || seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
  }
  return { total, cards };
}

export const OPPORTUNITY_WORDS = ["fellowship", "internship", "intern", "apprenticeship", "scholarship", "beasiswa", "magang", "lowongan", "loker", "hiring", "vacancy", "vacancies", "open recruitment", "graduate program", "trainee", "deadline", "funded", "stipend", "job opening"] as const;

function matchedWords(text: string): string[] {
  const lower = text.toLowerCase();
  return OPPORTUNITY_WORDS.filter((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u").test(lower));
}

const AGE = /^\s*- text: (\d+(?:mo|[hdwmy])) •/;
const REACTION_NOISE = /^(likes this|•|Follow|Like|Comment|Repost|Send|\d+(\.\d+)?[KM]?)$/i;

export function parseLinkedInFeed(aria: string, max: number): FeedPost[] {
  const lines = aria.split("\n").map(strip);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*- heading "Feed post"/.test(l)) starts.push(i);
  });
  const posts: FeedPost[] = [];
  for (let k = 0; k < starts.length && posts.length < max; k++) {
    const block = lines.slice(starts[k]!, k + 1 < starts.length ? starts[k + 1]! : lines.length);
    const parts: string[] = [];
    for (const l of block) {
      const t = /^\s*- (?:text|strong): (.*)$/.exec(l);
      if (!t) continue;
      const v = unwrap(t[1]!);
      if (v.length < 2 || REACTION_NOISE.test(v) || AGE.test(l)) continue;
      parts.push(v);
    }
    const text = clean(redactContact(parts.join(" ")), 1500);
    const keywords = matchedWords(text);
    if (keywords.length === 0) continue;
    const company = block.map((l) => /\/url: https:\/\/www\.linkedin\.com\/company\/([A-Za-z0-9._-]+)\/?/.exec(l)?.[1]).find(Boolean) ?? null;
    posts.push({
      source_company: company,
      age: block.map((l) => AGE.exec(l)?.[1]).find(Boolean) ?? null,
      promoted: block.some((l) => /^\s*- paragraph: Promoted$/.test(l)),
      keywords,
      excerpt: text.slice(0, 700),
    });
  }
  return posts;
}
