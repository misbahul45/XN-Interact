import { encode } from "gpt-tokenizer/encoding/o200k_base";
import pkg from "../../node_modules/gpt-tokenizer/package.json" with { type: "json" };

export const TOKENIZER = {
  name: "gpt-tokenizer",
  encoding: "o200k_base",
  version: (pkg as { version: string }).version,
  caveat: "Proxy for the host model's tokenizer: use for relative comparison between variants, not as the host's billed count.",
};

export function countTokens(text: string): number {
  return encode(text).length;
}

export function measure(text: string): { bytes: number; tokens: number } {
  return { bytes: new TextEncoder().encode(text).length, tokens: countTokens(text) };
}

export interface CallStat {
  tool: string;
  args: { bytes: number; tokens: number };
  out: { bytes: number; tokens: number };
  ok: boolean;
}

export interface ScenarioResult {
  id: string;
  title: string;
  calls: number;
  arg_tokens: number;
  out_tokens: number;
  total_tokens: number;
  total_bytes: number;
  ok: boolean;
  by_call: CallStat[];
}

export type Invoker = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean }>;

export class Meter {
  readonly stats: CallStat[] = [];

  constructor(private readonly invoke: Invoker) {}

  async call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.invoke(tool, args);
    this.stats.push({ tool, args: measure(JSON.stringify(args)), out: measure(JSON.stringify(r)), ok: r.ok });
    return r;
  }

  result(id: string, title: string): ScenarioResult {
    const arg_tokens = this.stats.reduce((a, s) => a + s.args.tokens, 0);
    const out_tokens = this.stats.reduce((a, s) => a + s.out.tokens, 0);
    return {
      id,
      title,
      calls: this.stats.length,
      arg_tokens,
      out_tokens,
      total_tokens: arg_tokens + out_tokens,
      total_bytes: this.stats.reduce((a, s) => a + s.args.bytes + s.out.bytes, 0),
      ok: this.stats.length > 0,
      by_call: this.stats,
    };
  }
}

export interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  title?: string;
}

export function registryStats(tools: ToolListEntry[]) {
  const whole = measure(JSON.stringify(tools));
  const withoutOutput = measure(JSON.stringify(tools.map(({ outputSchema: _o, ...rest }) => rest)));
  const per = tools.map((t) => ({ name: t.name, ...measure(JSON.stringify(t)) })).sort((a, b) => b.tokens - a.tokens);
  return { tools: tools.length, ...whole, tokens_without_output_schema: withoutOutput.tokens, bytes_without_output_schema: withoutOutput.bytes, largest: per.slice(0, 5), per_tool_mean_tokens: Math.round(whole.tokens / Math.max(tools.length, 1)) };
}
