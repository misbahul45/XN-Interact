import type { Page } from "playwright-core";
import { digest } from "../contracts/canonical.ts";
import { inspectPage, SourceStop } from "../browser/runtime.ts";
import { inScope, type Source } from "./contracts.ts";

export interface BrowserRow {
  id: string | null;
  detail: string | null;
  fields: Record<string, string[]>;
}

export interface BrowserBatch {
  rows: BrowserRow[];
  end: boolean;
  next: string | null;
  ambiguous: boolean;
  truncated: boolean;
  empty: boolean;
  expectedTotal: number | null;
}

export async function readBatch(page: Page, source: Source, names: string[], detail = false): Promise<BrowserBatch> {
  await inspectPage(page, source);
  const main = page.locator("main");
  if (await main.count() !== 1 || !await main.isVisible()) throw new SourceStop("ui_changed");
  const batch = await main.evaluate((main, { names, detail, layout }) => {
    const visible = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible" &&
      !node.closest("form,input,textarea,select,dialog,[hidden],[inert],[aria-hidden=true]");
    const text = (node: Element) => (node as HTMLElement).innerText?.slice(0, 1000) ?? "";
    const all = (selector: string, parent: Element = main) => Array.from(parent.querySelectorAll(selector)).filter(visible);
    const tables = all("table");
    const nodes = detail ? [main] : layout === "table" && tables.length === 1 ? all("tbody tr", tables[0]) : all("[data-xn-record]");
    const headers = tables.length === 1 ? all("thead th", tables[0])
      .map((cell) => text(cell).trim().toLowerCase().replace(/\s+/g, "_")) : [];
    const rows = nodes.slice(0, 500).map((row) => {
      const fields: Record<string, string[]> = {};
      if (!detail && layout === "table") {
        Array.from(row.children).forEach((cell, i) => {
          const name = headers[i];
          if (name && names.includes(name) && headers.indexOf(name) === headers.lastIndexOf(name) && visible(cell)) fields[name] = [text(cell)];
        });
      } else {
        for (const node of all("[data-xn-field]", row).slice(0, 160)) {
          const name = node.getAttribute("data-xn-field");
          if (name && names.includes(name)) (fields[name] ??= []).push(node instanceof HTMLAnchorElement ? (node.href || text(node)).slice(0, 1000) : text(node));
        }
      }
      const links = all("a[data-xn-detail]", row);
      return { id: row.getAttribute("data-xn-record")?.slice(0, 128) ?? null, detail: links.length === 1 ? (links[0] as HTMLAnchorElement).href.slice(0, 1000) : null, fields };
    });
    const next = all("a[rel~=next]");
    const totals = all("[data-xn-total]");
    const total = totals.length === 1 ? totals[0]!.getAttribute("data-xn-total") : null;
    return {
      rows, end: all("[data-xn-end]").length === 1, truncated: nodes.length > 500, empty: nodes.length === 0,
      next: next.length === 1 ? (next[0] as HTMLAnchorElement).href.slice(0, 1000) : null,
      ambiguous: next.length > 1 || (layout === "table" && !detail && tables.length !== 1),
      expectedTotal: total && /^\d{1,8}$/.test(total) ? Number(total) : null,
    };
  }, { names, detail, layout: source.layout });
  await inspectPage(page, source);
  return batch;
}

export async function advanceUi(page: Page, source: Source, names: string[], previous: BrowserBatch): Promise<BrowserBatch | null> {
  const baseline = digest(previous.rows);
  if (source.mechanism === "load_more") {
    const button = page.locator("main button[data-xn-more]:visible");
    if (await button.count() !== 1 || !await button.isEnabled() || await button.getAttribute("type") !== "button" || await button.getAttribute("form")) return null;
    await button.click({ timeout: 4_000 });
  } else {
    const scrollContainer = page.locator("main [data-xn-scroll]:visible");
    if (await scrollContainer.count() > 1) return null;
    if (await scrollContainer.count() === 1) {
      await scrollContainer.evaluate((element) => element.scrollBy(0, element.clientHeight || 600));
    } else {
      await page.mouse.wheel(0, 850);
    }
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    await Bun.sleep(150);
    const now = await readBatch(page, source, names);
    if (now.end || digest(now.rows) !== baseline) return now;
  }
  return null;
}

export function assertContinuation(source: Source, url: string) {
  if (!inScope(source, url)) throw new SourceStop("restriction");
}
