import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { loadConfig } from "../../src/bootstrap/config.ts";
import { brokerCall, brokerCommand } from "../../src/browser/ipc.ts";

test.skipIf(process.env.XN_INTERACT_SYSTEMD_TEST !== "1")("a systemd user service restarts the broker after SIGKILL", async () => {
  const unit = `xn-interact-test-${crypto.randomUUID()}.service`;
  const home = mkdtempSync("/tmp/xn-broker-systemd-");
  const config = loadConfig({ XN_INTERACT_HOME: home, XN_INTERACT_ENV: "test" });
  function run(args: string[]) {
    const proc = Bun.spawnSync(args, { stderr: "pipe", stdout: "pipe" });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  }
  async function wait(old?: number) {
    for (let i = 0; i < 100; i++) {
      const status = await brokerCall(config, "status");
      if (status && status.pid !== old) return status.pid;
      await Bun.sleep(100);
    }
    throw new Error("transient broker did not become ready");
  }
  run(["systemd-run", "--user", "--quiet", "--collect", `--unit=${unit}`, "--property=Restart=on-failure",
    "--property=RestartSec=1", "--property=UMask=0077", "--property=KillMode=mixed", `--setenv=XN_INTERACT_HOME=${home}`,
    "--setenv=XN_INTERACT_ENV=test", "--setenv=XN_INTERACT_BROWSER_CONTINUOUS=1", ...brokerCommand(config)]);
  try {
    const pid = await wait();
    run(["systemctl", "--user", "kill", "--kill-whom=main", "--signal=SIGKILL", unit]);
    expect(await wait(pid)).not.toBe(pid);
  } finally {
    run(["systemctl", "--user", "stop", unit]);
  }
}, 30_000);
