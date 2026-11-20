import bridge from "../plan/bridge.json" with { type: "json" };

type Cap = { id: string; tools: string[]; cost: string; description: string; degraded: string };
const b = bridge as unknown as { server: string; capabilities: Cap[]; risk_rules: { server: string; tool: string; risk: string }[] };
const q = (s: string) => JSON.stringify(s);

export function capabilitiesToml(): string {
  const out: string[] = [];
  for (const c of b.capabilities) {
    out.push("", `[capability.${q(c.id)}]`, `description = ${q(c.description)}`, `degraded = ${q(c.degraded)}`);
    for (const t of c.tools) out.push(`[[capability.${q(c.id)}.provider]]`, `server = ${q(b.server)}`, `tool = ${q(t)}`, `cost = ${q(c.cost)}`);
  }
  return `${out.join("\n")}\n`;
}

export function riskToml(): string {
  return `${b.risk_rules.map((r) => `[[risk]]\nserver = ${q(r.server)}\ntool = ${q(r.tool)}\nrisk = ${q(r.risk)}`).join("\n")}\n`;
}

if (import.meta.main) {
  const which = Bun.argv[2];
  process.stdout.write(which === "risk" ? riskToml() : capabilitiesToml());
}
