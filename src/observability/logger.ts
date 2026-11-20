import { redactor } from "./redact.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: Level = "info";
let sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`);

export function configureLogger(level: Level, out?: (line: string) => void): void {
  threshold = level;
  if (out) sink = out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const rec = { at: new Date().toISOString(), level, msg: redactor.text(msg), ...(fields ? (redactor.value(fields) as Record<string, unknown>) : {}) };
  sink(JSON.stringify(rec));
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
