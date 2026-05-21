# lightfunnels-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
your **[Lightfunnels](https://lightfunnels.com)** account to ChatGPT, Claude
Desktop, Cursor, Continue, and any other MCP-compatible client.

It wraps the **Lightfunnels GraphQL API** (https://developer.lightfunnels.com) so
an LLM can answer questions like:

- "How many orders did I get today?"
- "What's my total sales this month?"
- "List my top-selling products."
- "Show me all pending orders."
- "Give me a daily breakdown of orders for the last 30 days."

## What's in the box

| Tool                    | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `lf_list_orders`        | List orders with pagination and filtering                |
| `lf_get_order`          | Retrieve a single order with full details                |
| `lf_list_products`      | List products with pagination                            |
| `lf_get_product`        | Retrieve a single product with variants and images       |
| `lf_list_funnels`       | List funnels with pagination                             |
| `lf_get_funnel`         | Retrieve a single funnel                                 |
| `lf_list_customers`     | List customers with pagination                           |
| `lf_get_customer`       | Retrieve a single customer                               |
| `lf_account_settings`   | Retrieve account settings and tracking pixels            |
| `lf_summarize_orders`   | Aggregate order analytics (totals, averages, breakdowns) |
| `lf_raw_query`          | Execute arbitrary GraphQL queries (escape hatch)         |

### Aggregation tools

`lf_summarize_orders` paginates through all orders in a date range and computes:
- Total orders, total sales, average order value
- Breakdown by fulfillment status and financial status
- Cancelled order count
- Optional time-series with `bucket: "day" | "week" | "month"`

## Authentication

Lightfunnels uses **OAuth 2** with permanent access tokens. You need to:

1. Create a Lightfunnels app at [partners.lightfunnels.com](https://partners.lightfunnels.com)
2. Go through the OAuth consent flow to obtain a permanent access token
3. Set it as the `LIGHTFUNNELS_ACCESS_TOKEN` environment variable

See the [Lightfunnels authentication docs](https://developer.lightfunnels.com/authentication) for details.

## Usage

### Claude Desktop / Cursor (stdio)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "lightfunnels": {
      "command": "npx",
      "args": ["lightfunnels-mcp"],
      "env": {
        "LIGHTFUNNELS_ACCESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

### HTTP / ChatGPT (Streamable HTTP)

```bash
# Set required env vars
export LIGHTFUNNELS_ACCESS_TOKEN="your-token"
export MCP_AUTH_TOKEN=$(openssl rand -base64 32)

# Run
npm run start:http
```

The MCP endpoint is at `POST /mcp`. It supports:
- **Admin Bearer token**: pass `MCP_AUTH_TOKEN` as `Authorization: Bearer <token>` for curl / Claude Desktop
- **OAuth 2.1**: ChatGPT-compatible with PKCE + Dynamic Client Registration

### Environment variables

| Variable                    | Required | Description                                                |
| --------------------------- | -------- | ---------------------------------------------------------- |
| `LIGHTFUNNELS_ACCESS_TOKEN` | Yes      | Permanent OAuth access token from Lightfunnels             |
| `MCP_AUTH_TOKEN`            | HTTP only| Admin bearer token / OAuth login password                  |
| `MCP_PUBLIC_URL`            | No       | Public URL for OAuth discovery (defaults to `http://host:port`) |
| `PORT`                      | No       | HTTP server port (default `8080`)                          |
| `HOST`                      | No       | HTTP server bind address (default `0.0.0.0`)               |
| `LIGHTFUNNELS_BASE_URL`     | No       | Override GraphQL endpoint                                  |
| `LIGHTFUNNELS_TIMEOUT_MS`   | No       | Request timeout in ms (default `30000`)                    |

## Deployment (Fly.io)

```bash
# First time
flyctl launch --no-deploy

# Set secrets
flyctl secrets set \
  LIGHTFUNNELS_ACCESS_TOKEN=your-token \
  MCP_AUTH_TOKEN=$(openssl rand -base64 32)

# Deploy
flyctl deploy
```

## Development

```bash
npm install
npm run dev        # stdio mode
npm run dev:http   # HTTP mode (needs MCP_AUTH_TOKEN)
npm run lint
npm run typecheck
npm run build
```

## License

MIT
