const SENSITIVE_KEY = /(token|secret|password|passphrase|authorization|verifier|cookie|api[_-]?key)|^code$/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export class Redactor {
  private readonly secrets = new Set<string>();

  register(value: string | undefined | null): void {
    if (value && value.length >= 6) this.secrets.add(value);
  }

  forget(value: string | undefined | null): void {
    if (value) this.secrets.delete(value);
  }

  text(input: string): string {
    let out = input.replace(BEARER, "$1 [REDACTED]");
    for (const s of this.secrets) if (out.includes(s)) out = out.split(s).join("[REDACTED]");
    return out;
  }

  value(input: unknown, depth = 0): unknown {
    if (depth > 12) return "[TRUNCATED]";
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map((x) => this.value(x, depth + 1));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) out[k] = SENSITIVE_KEY.test(k) && v != null && typeof v !== "boolean" && typeof v !== "number" ? "[REDACTED]" : this.value(v, depth + 1);
      return out;
    }
    return input;
  }
}

export const redactor = new Redactor();
