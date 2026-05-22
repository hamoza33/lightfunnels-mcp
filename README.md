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

## Tools (13 total)

| Tool                    | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `lf_list_orders`        | List orders with pagination, ISO dates, and funnel_id                    |
| `lf_get_order`          | Single order with full details, items, shipping address                  |
| `lf_fetch_all_orders`   | Fetch one batch of orders (cursor-paginated). Use `lf_export_orders` for full file exports |
| `lf_export_orders`      | **Export orders to a downloadable xlsx / csv / jsonl file URL** (server-paginates internally) |
| `lf_list_products`      | List products with pagination                                            |
| `lf_get_product`        | Single product with variants and images                                  |
| `lf_list_funnels`       | List funnels with pagination                                             |
| `lf_get_funnel`         | Single funnel details                                                    |
| `lf_list_customers`     | List customers with pagination                                           |
| `lf_get_customer`       | Single customer details                                                  |
| `lf_account_settings`   | Account settings and tracking pixels                                     |
| `lf_summarize_orders`   | Aggregate analytics with date filtering                                  |
| `lf_raw_query`          | Execute arbitrary GraphQL (escape hatch)                                 |

### Key features

- **ISO timestamps** — all `created_at`/`updated_at` fields return `YYYY-MM-DDTHH:mm:ss` format (not relative strings)
- **Funnel tracking** — every order includes `funnel_id` so you can attribute sales to funnels
- **Exact date filtering** — `lf_fetch_all_orders`, `lf_export_orders`, and `lf_summarize_orders` support `since_date`/`until_date` params
- **Server-side pagination** — `lf_export_orders` and `lf_summarize_orders` paginate internally so the LLM doesn't have to drive `next_cursor` round trips
- **File exports** — `lf_export_orders` returns an xlsx/csv/jsonl download URL so 100s–1000s of order rows never have to flow through the chat channel
- **Rate limit handling** — automatic retry with exponential backoff on API rate limits
- **Phone normalization** — customer + shipping phone numbers are normalized to canonical digits using the order's country code
- **Product filtering** — pass `product_id:<id>` in the query string to filter orders by product

### lf_fetch_all_orders

Returns **one batch** of orders with full details using cursor-based pagination.
Pass `next_cursor` from the previous response to fetch the next batch. Suitable
for dashboards or summaries where the client (LLM) processes orders one batch at a
time.

**For exporting hundreds of orders into a spreadsheet, use `lf_export_orders`
instead** — it paginates server-side and never streams the order rows through
the chat channel.

### lf_export_orders

Exports orders to a downloadable **xlsx, csv, or jsonl** file. The MCP server
paginates the Lightfunnels API internally, builds the file, and returns a small
JSON response with a `file_url`. The order rows themselves never flow through
the MCP/chat channel — this is how you reliably move 100s–1000s of customer
records into a spreadsheet from ChatGPT, Claude, or any MCP client without
token bloat or truncation.

Example call (ChatGPT):

```json
{
  "name": "lf_export_orders",
  "arguments": {
    "query": "order_by:created_at order_dir:desc product_id:prod_abc123",
    "since_date": "2026-04-01",
    "until_date": "2026-05-21",
    "include_test": false,
    "format": "xlsx",
    "include_items": true,
    "include_utm": true,
    "include_raw_json": false,
    "normalize_phones": true
  }
}
```

Example response:

```json
{
  "file_url": "https://lightfunnels-mcp.fly.dev/files/<random>/lightfunnel_orders_prod_abc123_2026-04-01_2026-05-21_<ts>.xlsx",
  "file_name": "lightfunnel_orders_prod_abc123_2026-04-01_2026-05-21_<ts>.xlsx",
  "total_orders": 422,
  "format": "xlsx",
  "sheets": ["orders", "line_items", "utm"],
  "size_bytes": 87431,
  "expires_at": "2026-05-22T01:17:00.000Z",
  "truncated": false,
  "pages_fetched": 5,
  "date_filter": { "since": "2026-04-01", "until": "2026-05-21" }
}
```

Format details:
- **xlsx** — multi-sheet workbook (`orders`, optional `line_items`, optional `utm`, optional `raw_json`).
- **csv** — single flat sheet with optional `items_json`, `utm_json`, `raw_json` columns. UTF-8 BOM so Excel opens it cleanly.
- **jsonl** — one full order JSON object per line.

The `orders` sheet/columns include a computed `funnel_url` field
(`https://<funnel_domain>/<funnel_slug>`) so the landing page URL that
generated each order is available without any post-processing.

File hosting:
- **HTTP mode**: files are kept in memory on the MCP server and served from
  `GET /files/:id/:filename`. The 32-byte random ID in the URL acts as a bearer
  token — anyone with the link can download once, until it expires (default 1h,
  configurable via `ttl_seconds` up to 24h).
- **stdio mode**: files are written to a temp directory and a `file://` URL is
  returned (useful for local Claude Desktop / Cursor usage).

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
