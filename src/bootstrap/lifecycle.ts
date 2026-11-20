import { log } from "../observability/logger.ts";

export function onShutdown(fn: () => void | Promise<void>): void {
  let done = false;
  const run = async (signal: string) => {
    if (done) return;
    done = true;
    log.info("shutting down", { signal });
    try {
      await fn();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void run("SIGINT"));
  process.on("SIGTERM", () => void run("SIGTERM"));
  process.stdin.on("end", () => void run("stdin-end"));
}
