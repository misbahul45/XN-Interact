export const MIN_BUN = "1.3.0";

function parts(v: string): number[] {
  return v.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
}

export function assertRuntime(version: string = typeof Bun === "undefined" ? "" : Bun.version): void {
  if (!version) throw new Error("XN-Interact runs on Bun only");
  const a = parts(version);
  const b = parts(MIN_BUN);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return;
    if ((a[i] ?? 0) < (b[i] ?? 0)) throw new Error(`Bun ${MIN_BUN} or newer required, found ${version}`);
  }
}
