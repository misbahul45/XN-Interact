const service = "xn-interact-probe";
const name = `probe-${process.pid}`;
const out: Record<string, unknown> = { bun: Bun.version, dbus: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS), display: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) };
const t0 = performance.now();
try {
  await Bun.secrets.set({ service, name, value: "canary-value" });
  out.set = "ok";
  out.get = (await Bun.secrets.get({ service, name })) === "canary-value" ? "ok" : "mismatch";
  out.delete = (await Bun.secrets.delete({ service, name })) ? "ok" : "not-found";
  out.afterDelete = (await Bun.secrets.get({ service, name })) === null ? "absent" : "present";
} catch (e) {
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
out.ms = Math.round(performance.now() - t0);
console.log(JSON.stringify(out));
