#!/usr/bin/env node
/**
 * Lightfunnels MCP server — HTTP / Streamable HTTP entrypoint.
 *
 * Exposes the same MCP tools over the Streamable HTTP transport at `/mcp` so
 * URL-based MCP clients (ChatGPT custom connectors, n8n, etc.) can connect.
 *
 * Gated by OAuth 2.1 with PKCE + Dynamic Client Registration (required by
 * ChatGPT). The static `MCP_AUTH_TOKEN` is also accepted as a Bearer token
 * on `/mcp` for curl / Claude Desktop.
 *
 * Stateless mode: every POST /mcp spins up a fresh server+transport.
 */

import express from "express";
import type { Request, RequestHandler, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { buildMcpServer, readLfConfig } from "./build-server.js";
import { HttpFileStore } from "./file-store.js";
import { LfMcpOAuthProvider } from "./oauth.js";

const log = (...args: unknown[]): void => {
  process.stderr.write(`[lightfunnels-mcp:http] ${args.join(" ")}\n`);
};

function methodNotAllowed(res: Response): void {
  res.writeHead(405, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
}

async function main(): Promise<void> {
  const cfg = readLfConfig();
  const adminToken = process.env.MCP_AUTH_TOKEN;
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  if (!adminToken) {
    log(
      "ERROR: MCP_AUTH_TOKEN is required. It acts both as the admin Bearer token",
      "and as the password for the OAuth login page. Generate one with:",
      "`openssl rand -base64 32` and set it as a server env var.",
    );
    process.exit(1);
  }

  const issuerUrl = process.env.MCP_PUBLIC_URL
    ? new URL(process.env.MCP_PUBLIC_URL)
    : new URL(`http://${host}:${port}`);
  const mcpResourceUrl = new URL("/mcp", issuerUrl);

  const oauth = new LfMcpOAuthProvider(adminToken);

  const fileStore = new HttpFileStore({ baseUrl: issuerUrl });

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));

  app.use((req, _res, next) => {
    log(`${req.method} ${req.path} [${req.ip}] auth=${req.header("authorization")?.slice(0, 20) ?? "none"}`);
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // File downloads for `lf_export_orders` results. The 32-byte random ID in
  // the URL path acts as a bearer token — unguessable, no expiry.
  app.get("/files/:id/:filename", (req, res) => fileStore.serve(req, res));

  app.get("/", (_req, res) => {
    res.json({
      service: "lightfunnels-mcp",
      transport: "streamable-http",
      mcpEndpoint: mcpResourceUrl.toString(),
      oauthDiscovery: new URL(
        "/.well-known/oauth-authorization-server",
        issuerUrl,
      ).toString(),
      protectedResourceMetadata: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
      docs: "https://github.com/hamoza33/lightfunnels-mcp",
    });
  });

  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl,
      resourceServerUrl: mcpResourceUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "Lightfunnels MCP",
    }),
  );

  app.post("/oauth/approve", oauth.approveHandler);

  const oauthBearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
  });

  const adminOrOauthBearer: RequestHandler = (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && m[1] && oauth.isAdminToken(m[1].trim())) {
      const token = m[1].trim();
      const adminAuth: AuthInfo = {
        token,
        clientId: "admin",
        scopes: ["mcp:tools"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      (req as Request & { auth?: AuthInfo }).auth = adminAuth;
      next();
      return;
    }
    oauthBearer(req, res, next);
  };

  app.post("/mcp", adminOrOauthBearer, async (req, res) => {
    const { server } = buildMcpServer(cfg, { publisher: fileStore });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", adminOrOauthBearer, (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", adminOrOauthBearer, (_req, res) => methodNotAllowed(res));

  app.listen(port, host, () => {
    const { toolCount } = buildMcpServer(cfg, { publisher: fileStore });
    log(
      `Listening on ${host}:${port} — ${toolCount} tools`,
      `| MCP endpoint: ${mcpResourceUrl}`,
    );
  });
}

main().catch((err) => {
  log("Fatal:", err);
  process.exit(1);
});
