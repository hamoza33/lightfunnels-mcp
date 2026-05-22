#!/usr/bin/env node
/**
 * Lightfunnels MCP server — stdio entrypoint.
 *
 * Use this with Claude Desktop, Cursor, Continue, or any MCP client
 * that connects over stdin/stdout.
 *
 *   LIGHTFUNNELS_ACCESS_TOKEN=xxx npx lightfunnels-mcp
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, readLfConfig } from "./build-server.js";

const log = (...args: unknown[]): void => {
  process.stderr.write(`[lightfunnels-mcp] ${args.join(" ")}\n`);
};

async function main(): Promise<void> {
  const cfg = readLfConfig();
  const { server, toolCount } = buildMcpServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Running (stdio). ${toolCount} tools registered.`);
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
