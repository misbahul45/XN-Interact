import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import * as z from "zod/v4";
import type { Config } from "../bootstrap/config.ts";
import { GatewayError } from "../contracts/errors.ts";
import { browserDirectory } from "./runtime.ts";

export const wireRequest = z.strictObject({ id: z.uuid(), operation: z.enum(["status", "wake", "stop"]) });
export type WireOperation = z.output<typeof wireRequest>["operation"];
const status = z.strictObject({ pid: z.number().int(), browser_active: z.boolean(), active_run: z.string().nullable(), stopping: z.boolean() });
export type BrokerStatus = z.output<typeof status>;
const wireResponse = z.strictObject({ id: z.uuid(), status });
const ENTRY = join(import.meta.dir, "daemon.ts");
const FLOCK = "/usr/bin/flock";
export const MAX_FRAME = 4096;

export function brokerPaths(cfg: Config) {
  const dir = browserDirectory(cfg);
  const socket = join(dir, "broker.sock");
  if (Buffer.byteLength(socket) >= 108) throw new GatewayError("VALIDATION_FAILED", "XN_INTERACT_HOME is too long for the broker socket");
  return { socket, lock: join(dir, "owner.lock") };
}

export function assertSocket(path: string) {
  const st = lstatSync(path);
  if (!st.isSocket() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    throw new GatewayError("PROHIBITED", "broker socket must be owned by the desktop user");
  }
}

export function receiveFrame(socket: Socket, callback: (line: string) => void) {
  let pending = "";
  socket.setEncoding("utf8");
  socket.setTimeout(2500, () => socket.destroy());
  socket.on("data", (data: string) => {
    pending += data;
    if (Buffer.byteLength(pending) > MAX_FRAME) return socket.destroy();
    const i = pending.indexOf("\n");
    if (i === -1) return;
    socket.removeAllListeners("data");
    if (i !== pending.length - 1) return socket.destroy();
    callback(pending.slice(0, i));
  });
}

export async function brokerCall(cfg: Config, operation: WireOperation): Promise<BrokerStatus | null> {
  if (!existsSync(join(cfg.home, "browser", "broker.sock"))) return null;
  const { socket: path } = brokerPaths(cfg);
  try {
    assertSocket(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const request = { id: crypto.randomUUID(), operation };
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("error", (e: NodeJS.ErrnoException) => {
      if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTCONN"].includes(e.code ?? "")) resolve(null);
      else reject(new GatewayError("PROVIDER_UNAVAILABLE", "browser broker IPC failed"));
    });
    socket.once("close", () => resolve(null));
    receiveFrame(socket, (line) => {
      try {
        const reply = wireResponse.parse(JSON.parse(line));
        resolve(reply.id === request.id ? reply.status : null);
      } catch {
        resolve(null);
      } finally {
        socket.destroy();
      }
    });
  });
}

export function brokerCommand(cfg: Config, args: string[] = ["serve"]): string[] {
  const { lock } = brokerPaths(cfg);
  const fd = openSync(lock, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new GatewayError("PROHIBITED", "broker lock must be a private regular file");
    }
  } finally {
    closeSync(fd);
  }
  return [FLOCK, "-n", "--no-fork", lock, process.execPath, ENTRY, ...args];
}

export function brokerEnv(cfg: Config) {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "USER", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env, XN_INTERACT_HOME: cfg.home, XN_INTERACT_ENV: cfg.env,
    XN_INTERACT_BROWSER_IDLE_MS: String(cfg.browserIdleMs), XN_INTERACT_BROWSER_CONTINUOUS: cfg.browserContinuous ? "1" : "0",
  };
}

export async function ensureBroker(cfg: Config): Promise<BrokerStatus> {
  const existing = await brokerCall(cfg, "wake");
  if (existing && !existing.stopping) return existing;
  const [bin, ...args] = brokerCommand(cfg);
  const child = spawn(bin!, args, {
    detached: true, stdio: "ignore", env: brokerEnv(cfg),
  });
  child.on("error", () => {});
  child.unref();
  const deadline = Date.now() + 5000;
  do {
    await Bun.sleep(80);
    const ready = await brokerCall(cfg, "wake");
    if (ready && !ready.stopping) return ready;
  } while (Date.now() < deadline);
  throw new GatewayError("PROVIDER_UNAVAILABLE", "browser broker did not become ready", {
    actionable_next_step: "Check broker status or finish interactive authentication before retrying.",
  });
}
