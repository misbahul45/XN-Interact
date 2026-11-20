import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync, truncateSync } from "node:fs";
import { openApp, type TestCtx } from "../helpers.ts";

let ctx: TestCtx;
afterEach(() => ctx?.app.close());

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe("media sandbox", () => {
  test("refuses remote URLs, traversal, symlinks, unknown types and oversized files", async () => {
    ctx = await openApp();
    const inbox = `${ctx.home}/inbox`;
    await Bun.write(`${ctx.home}/outside.png`, PNG);
    await Bun.write(`${inbox}/ok.png`, PNG);
    symlinkSync(`${ctx.home}/outside.png`, `${inbox}/link.png`);
    await Bun.write(`${inbox}/notes.txt`, "hello");
    await Bun.write(`${inbox}/huge.png`, PNG);
    truncateSync(`${inbox}/huge.png`, 21 * 1024 * 1024);
    const cases: [string, string][] = [
      ["https://example.com/a.png", "PROHIBITED"],
      [`${inbox}/../outside.png`, "PROHIBITED"],
      [`${inbox}/link.png`, "PROHIBITED"],
      [`${inbox}/notes.txt`, "VALIDATION_FAILED"],
      [`${inbox}/huge.png`, "VALIDATION_FAILED"],
      [`${inbox}/missing.png`, "VALIDATION_FAILED"],
    ];
    for (const [path, code] of cases) expect(String((await ctx.call("social_media_upload", { path })).error?.code)).toBe(code);
    const ok = await ctx.call("social_media_upload", { path: `${inbox}/ok.png` });
    expect(ok.data.mime).toBe("image/png");
  });
});
