/**
 * Shared MCP server factory used by both the stdio entrypoint
 * (`server.ts`) and the HTTP entrypoint (`http.ts`).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LfApiError, LfClient } from "./client.js";
import { tools } from "./tools.js";

export interface LfConfig {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function readLfConfig(): LfConfig {
  const token = process.env.LIGHTFUNNELS_ACCESS_TOKEN;

  if (!token) {
    process.stderr.write(
      "[lightfunnels-mcp] ERROR: LIGHTFUNNELS_ACCESS_TOKEN is required.\n" +
        "Obtain a permanent access token via the Lightfunnels OAuth flow.\n" +
        "See: https://developer.lightfunnels.com/authentication\n",
    );
    process.exit(1);
  }

  const baseUrl = process.env.LIGHTFUNNELS_BASE_URL;

  let timeoutMs: number | undefined;
  if (process.env.LIGHTFUNNELS_TIMEOUT_MS) {
    const parsed = Number.parseInt(process.env.LIGHTFUNNELS_TIMEOUT_MS, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      process.stderr.write(
        `[lightfunnels-mcp] WARN: ignoring invalid LIGHTFUNNELS_TIMEOUT_MS=${JSON.stringify(
          process.env.LIGHTFUNNELS_TIMEOUT_MS,
        )}; expected a positive integer.\n`,
      );
    } else {
      timeoutMs = parsed;
    }
  }

  return { token, baseUrl, timeoutMs };
}

export function buildMcpServer(cfg: LfConfig): {
  server: Server;
  toolCount: number;
} {
  const client = new LfClient({
    token: cfg.token,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
  });

  const server = new Server(
    { name: "lightfunnels-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, { target: "openApi3" }),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }

    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
          },
        ],
      };
    }

    try {
      const data = await tool.handler(parsed.data as unknown, client);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof LfApiError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Lightfunnels API error (HTTP ${err.status}): ${err.message}` +
                (err.responseBody
                  ? `\n\nResponse:\n${JSON.stringify(err.responseBody, null, 2)}`
                  : ""),
            },
          ],
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Tool ${tool.name} failed: ${msg}` }],
      };
    }
  });

  return { server, toolCount: tools.length };
}
