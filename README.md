# lightfunnels-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
your **[Lightfunnels](https://lightfunnels.com)** account to Claude (Web & Desktop),
ChatGPT, Cursor, and any other MCP-compatible client.

It wraps the **Lightfunnels GraphQL API** (https://developer.lightfunnels.com) so
an LLM can answer questions like:

- "Get me all orders since April 1 for product X"
- "How many orders did I get today?"
- "What's my total sales this month by funnel?"
- "List all pending orders with phone numbers"
- "Give me a breakdown of orders by fulfillment status"

## Tools (12 total)

| Tool                    | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `lf_list_orders`        | List orders with pagination, ISO dates, and funnel_id    |
| `lf_get_order`          | Single order with full details, items, shipping address  |
| `lf_fetch_all_orders`   | **Fetch ALL orders** with date range & product filtering |
| `lf_list_products`      | List products with pagination                            |
| `lf_get_product`        | Single product with variants and images                  |
| `lf_list_funnels`       | List funnels with pagination                             |
| `lf_get_funnel`         | Single funnel details                                    |
| `lf_list_customers`     | List customers with pagination                           |
| `lf_get_customer`       | Single customer details                                  |
| `lf_account_settings`   | Account settings and tracking pixels                     |
| `lf_summarize_orders`   | Aggregate analytics with date filtering                  |
| `lf_raw_query`          | Execute arbitrary GraphQL (escape hatch)                 |

### Key features

- **ISO timestamps** — all `created_at`/`updated_at` fields return `YYYY-MM-DDTHH:mm:ss` format (not relative strings)
- **Funnel tracking** — every order includes `funnel_id` so you can attribute sales to funnels
- **Exact date filtering** — `lf_fetch_all_orders` and `lf_summarize_orders` support `since_date`/`until_date` params
- **Auto-pagination** — `lf_fetch_all_orders` fetches up to 10,000 orders automatically (100/page × 100 pages)
- **Rate limit handling** — automatic retry with exponential backoff on API rate limits
- **Product filtering** — pass `product_id:<id>` in the query string to filter orders by product

### lf_fetch_all_orders

Use this tool when you need the complete list of orders (not just a page). It:
- Paginates automatically (100 orders/page, up to 10,000 by default)
- Filters by exact date range (`since_date`, `until_date` in YYYY-MM-DD format)
- Filters by product (`product_id:<id>` in query string)
- Returns full order details: customer info, phone, items, shipping address, funnel_id
- Stops early once it reaches orders before `since_date` (efficient)

Example prompt: *"Get all orders for product prod_abc123 since 2026-04-01"*

### lf_summarize_orders

Computes aggregate analytics:
- Total orders, total sales, average order value
- Breakdown by fulfillment status, financial status, currency, and funnel
- Supports date range filtering (`since_date`/`until_date`)
- Cancelled order count

## Authentication

Lightfunnels uses **OAuth 2** with permanent access tokens:

1. Create a Lightfunnels app at [partners.lightfunnels.com](https://partners.lightfunnels.com)
2. Set the **Redirect URI** to `https://localhost:3000/callback`
3. Visit the OAuth consent URL:
   ```
   https://app.lightfunnels.com/admin/oauth?client_id=YOUR_CLIENT_ID&redirect_uri=https://localhost:3000/callback&scope=orders,products,analytics,funnels,customers,settings
   ```
4. Approve → copy the `code` from the redirect URL
5. Exchange for permanent token:
   ```bash
   curl -X POST https://api.lightfunnels.com/api/access_token \
     -H "Authorization: Basic $(echo -n 'CLIENT_ID:CLIENT_SECRET' | base64)" \
     -d "code=THE_CODE"
   ```

See the [Lightfunnels auth docs](https://developer.lightfunnels.com/authentication) for details.

## Setup & Usage

### Option 1: Claude Web (Recommended)

Claude Web connects via OAuth to the deployed HTTP server:

1. Go to **Claude.ai → Settings → Integrations → Add MCP Server**
2. Enter the server URL (your deployed instance)
3. Approve the OAuth consent (enter your `MCP_AUTH_TOKEN` when prompted)
4. All 12 tools will be available in your Claude conversations

### Option 2: Claude Desktop / Cursor (stdio)

Clone and build locally:

```bash
git clone https://github.com/hamoza33/lightfunnels-mcp.git
cd lightfunnels-mcp
npm install && npm run build
```

Add to your MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lightfunnels": {
      "command": "node",
      "args": ["/path/to/lightfunnels-mcp/dist/server.js"],
      "env": {
        "LIGHTFUNNELS_ACCESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Option 3: Self-hosted HTTP server

```bash
# Set required env vars
export LIGHTFUNNELS_ACCESS_TOKEN="your-token"
export MCP_AUTH_TOKEN="your-admin-password"

# Run
npm run start:http
```

The MCP endpoint is at `POST /mcp`. It supports:
- **Bearer token auth**: `Authorization: Bearer <MCP_AUTH_TOKEN>`
- **OAuth 2.1**: PKCE + Dynamic Client Registration (for Claude Web / ChatGPT)

### Environment variables

| Variable                    | Required | Description                                                |
| --------------------------- | -------- | ---------------------------------------------------------- |
| `LIGHTFUNNELS_ACCESS_TOKEN` | Yes      | Permanent OAuth access token from Lightfunnels             |
| `MCP_AUTH_TOKEN`            | HTTP only| Admin bearer token / OAuth login password                  |
| `MCP_PUBLIC_URL`            | No       | Public URL for OAuth discovery (defaults to auto-detect)   |
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
  MCP_AUTH_TOKEN=your-admin-password

# Deploy
flyctl deploy
```

After deployment, use `https://your-app.fly.dev/mcp` as the MCP endpoint.

For **Claude Web integration**, set the Redirect URI in your Lightfunnels app to:
```
https://claude.ai/api/mcp/auth_callback
```

## Query string filters

The `query` parameter in order tools supports these filters:

| Filter               | Example                              | Description              |
| -------------------- | ------------------------------------ | ------------------------ |
| `order_by`           | `order_by:created_at`                | Sort field               |
| `order_dir`          | `order_dir:desc`                     | Sort direction           |
| `product_id`         | `product_id:prod_abc123`             | Filter by product        |
| `status`             | `status:active`                      | Order status             |
| `financial_status`   | `financial_status:paid`              | Payment status           |
| `fulfillment_status` | `fulfillment_status:unfulfilled`     | Shipping status          |

Multiple filters: `"order_by:created_at order_dir:desc product_id:prod_abc123"`

## Development

```bash
npm install
npm run build       # compile TypeScript
npm run start       # stdio mode
npm run start:http  # HTTP mode (needs MCP_AUTH_TOKEN)
npm run lint
npm run typecheck
```

## License

MIT
