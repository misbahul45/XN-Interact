import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({ name: "xn-interact-spike", version: "0.0.1" });

server.registerTool(
  "social_spike_echo",
  {
    description: "Echo a value",
    inputSchema: z.object({ value: z.string().max(100) }),
    outputSchema: z.object({ echoed: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ value }) => {
    console.error(`stderr log: echo ${value}`);
    return { content: [{ type: "text", text: JSON.stringify({ echoed: value }) }], structuredContent: { echoed: value } };
  },
);

server.registerTool("social.spike.dotted", { description: "Dotted-name probe", inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "ok" }] }));

await server.connect(new StdioServerTransport());
