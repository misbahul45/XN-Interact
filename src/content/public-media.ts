import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** A hosted file is named after the sha256 of its bytes, so the URL itself says which approved file it is. */
export const HOSTED_NAME = /^[0-9a-f]{64}\.jpg$/;

/**
 * Copy an approved JPEG into a local git checkout that is served publicly, commit it and push. This is the one step that
 * makes the file fetchable by anyone; it is only called from the owner's terminal after a typed confirmation.
 */
export function hostPublicly(dir: string, source: string, name: string, message: string): { committed: boolean } {
  if (!HOSTED_NAME.test(name)) throw new Error("a hosted file must be named <sha256>.jpg");
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is not a git checkout`);
  copyFileSync(source, join(dir, name));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const must = (r: ReturnType<typeof git>, what: string) => {
    if (r.exitCode !== 0) throw new Error(`${what} failed: ${r.stderr.toString().trim().slice(0, 300)}`);
  };
  must(git("add", "--", name), "git add");
  let committed = false;
  if (git("diff", "--cached", "--quiet", "--", name).exitCode !== 0) {
    must(git("commit", "-m", message, "--", name), "git commit");
    committed = true;
  }
  must(git("push"), "git push");
  return { committed };
}
