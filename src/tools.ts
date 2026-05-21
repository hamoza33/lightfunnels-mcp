/**
 * Tool definitions for the Lightfunnels MCP server.
 *
 * Each tool maps to one or more GraphQL queries against
 * https://services.lightfunnels.com/api/v2
 * documented at https://developer.lightfunnels.com
 */

import { z } from "zod";
import type { LfClient } from "./client.js";

/* -------------------------------------------------------------------------- */
/*  Tool registry                                                             */
/* -------------------------------------------------------------------------- */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown, client: LfClient) => Promise<unknown>;
}

interface TypedToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>, client: LfClient) => Promise<unknown>;
}

function tool<S extends z.ZodTypeAny>(def: TypedToolDef<S>): ToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: (input, client) => def.handler(input as z.infer<S>, client),
  };
}

/* -------------------------------------------------------------------------- */
/*  Shared pagination helpers                                                 */
/* -------------------------------------------------------------------------- */

const PaginationInput = {
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of items to return (max 100, default 25)."),
  after: z
    .string()
    .optional()
    .describe("Cursor for pagination — pass `endCursor` from a previous response."),
};

interface PageInfo {
  endCursor: string | null;
  hasNextPage: boolean;
}

interface Edge<N> {
  node: N;
  cursor: string;
}

interface Connection<N> {
  edges: Edge<N>[];
  pageInfo: PageInfo;
}

/* -------------------------------------------------------------------------- */
/*  Orders                                                                    */
/* -------------------------------------------------------------------------- */

const ORDER_FIELDS = `
  id
  _id
  name
  total
  subtotal
  shipping
  currency
  fulfillment_status
  financial_status
  funnel_id
  customer {
    id
    _id
    full_name
    email
    phone
  }
  cancelled_at
  test
  created_at(format: "YYYY-MM-DDTHH:mm:ss")
  updated_at(format: "YYYY-MM-DDTHH:mm:ss")
`;

const ORDER_DETAIL_FIELDS = `
  id
  _id
  name
  total
  subtotal
  shipping
  discount_value
  refunded_amount
  net_payment
  paid_by_customer
  original_total
  currency
  fulfillment_status
  financial_status
  funnel_id
  customer {
    id
    _id
    full_name
    email
    phone
  }
  items {
    ... on VariantSnapshot {
      id
      _id
      title
      sku
      price
      product_id
      fulfillment_status
      financial_status
      tracking_number
      tracking_link
      carrier
    }
    ... on OrderBumpSnapshot {
      id
      _id
      title
      sku
      price
      product_id
      fulfillment_status
      financial_status
      tracking_number
      tracking_link
      carrier
    }
  }
  shipping_address {
    first_name
    last_name
    line1
    line2
    city
    country
    zip
    phone
  }
  notes
  tags
  cancelled_at
  test
  created_at(format: "YYYY-MM-DDTHH:mm:ss")
  updated_at(format: "YYYY-MM-DDTHH:mm:ss")
`;

const listOrders = tool({
  name: "lf_list_orders",
  description:
    "List orders with pagination. Returns ISO timestamps and funnel_id for each order. Supports filtering by status, financial_status, fulfillment_status, and product_id via the query string. Example: 'order_by:created_at order_dir:desc product_id:prod_abc123'. For fetching ALL orders with date filtering, use lf_fetch_all_orders instead.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .default("order_by:created_at order_dir:desc")
      .describe(
        "Filter/sort string. Supported params: order_by (id, created_at), order_dir (asc, desc), status, financial_status, fulfillment_status, product_id.",
      ),
    ...PaginationInput,
  }),
  handler: async (input, client) => {
    const variables: Record<string, unknown> = { query: input.query };
    if (input.first) variables.first = input.first;
    if (input.after) variables.after = input.after;

    return client.query<{ orders: Connection<unknown> }>(
      `query ListOrders($first: Int, $after: String, $query: String!) {
        orders(query: $query, first: $first, after: $after) {
          edges {
            node { ${ORDER_FIELDS} }
            cursor
          }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      variables,
    );
  },
});

const getOrder = tool({
  name: "lf_get_order",
  description: "Retrieve a single order by its ID with full details including line items and shipping address.",
  inputSchema: z.object({
    id: z.string().describe("The order ID (e.g. 'order_T3JkZXI6MTgyNTE0')."),
  }),
  handler: async (input, client) => {
    return client.query(
      `query GetOrder($id: ID!) {
        node(id: $id) {
          ... on Order { ${ORDER_DETAIL_FIELDS} }
        }
      }`,
      { id: input.id },
    );
  },
});

/* -------------------------------------------------------------------------- */
/*  Products                                                                  */
/* -------------------------------------------------------------------------- */

const PRODUCT_FIELDS = `
  id
  _id
  title
  price
  compare_at_price
  product_type
  created_at
  thumbnail {
    path(version: version1)
  }
`;

const PRODUCT_DETAIL_FIELDS = `
  id
  _id
  title
  slug
  description
  notice_text
  price
  compare_at_price
  product_type
  sku
  enable_inventory_limit
  inventory_quantity
  images {
    id
    path(version: version1)
  }
  variants {
    id
    _id
    title
    price
    sku
  }
  created_at
  updated_at
`;

const listProducts = tool({
  name: "lf_list_products",
  description:
    "List products with pagination. Supports filtering via query string with order_by, order_dir, and time filters (last_month, last_week, last_3_months, last_year).",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .default("order_by:id order_dir:desc")
      .describe("Filter/sort string. Supported: order_by, order_dir, last_month, last_week, last_3_months, last_year."),
    ...PaginationInput,
  }),
  handler: async (input, client) => {
    const variables: Record<string, unknown> = { query: input.query };
    if (input.first) variables.first = input.first;
    if (input.after) variables.after = input.after;

    return client.query(
      `query ListProducts($first: Int, $after: String, $query: String!) {
        products(query: $query, first: $first, after: $after) {
          edges {
            node { ${PRODUCT_FIELDS} }
            cursor
          }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      variables,
    );
  },
});

const getProduct = tool({
  name: "lf_get_product",
  description: "Retrieve a single product by its ID with full details including variants and images.",
  inputSchema: z.object({
    id: z.string().describe("The product ID."),
  }),
  handler: async (input, client) => {
    return client.query(
      `query GetProduct($id: ID!) {
        node(id: $id) {
          ... on Product { ${PRODUCT_DETAIL_FIELDS} }
        }
      }`,
      { id: input.id },
    );
  },
});

/* -------------------------------------------------------------------------- */
/*  Funnels                                                                   */
/* -------------------------------------------------------------------------- */

const FUNNEL_FIELDS = `
  id
  _id
  name
  slug
  published
  created_at
`;

const FUNNEL_DETAIL_FIELDS = `
  id
  _id
  name
  slug
  published
  starting_step_id
  record
  activate_google_analytics
  active_facebook_pixels
  active_tiktok_pixels
  active_snapchat_pixels
  active_pinterest_pixels
  active_google_ads_pixels
  currency
  currency_format
  created_at
  updated_at
`;

const listFunnels = tool({
  name: "lf_list_funnels",
  description:
    "List funnels with pagination. Supports filtering by order_by, order_dir, published (boolean), and product_id.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .default("order_by:id order_dir:desc")
      .describe("Filter/sort string. Supported: order_by, order_dir, published, product_id."),
    ...PaginationInput,
  }),
  handler: async (input, client) => {
    const variables: Record<string, unknown> = { query: input.query };
    if (input.first) variables.first = input.first;
    if (input.after) variables.after = input.after;

    return client.query(
      `query ListFunnels($first: Int, $after: String, $query: String!) {
        funnels(query: $query, first: $first, after: $after) {
          edges {
            node { ${FUNNEL_FIELDS} }
            cursor
          }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      variables,
    );
  },
});

const getFunnel = tool({
  name: "lf_get_funnel",
  description: "Retrieve a single funnel by its ID with full details.",
  inputSchema: z.object({
    id: z.string().describe("The funnel ID."),
  }),
  handler: async (input, client) => {
    return client.query(
      `query GetFunnel($id: ID!) {
        node(id: $id) {
          ... on Funnel { ${FUNNEL_DETAIL_FIELDS} }
        }
      }`,
      { id: input.id },
    );
  },
});

/* -------------------------------------------------------------------------- */
/*  Customers                                                                 */
/* -------------------------------------------------------------------------- */

const CUSTOMER_FIELDS = `
  id
  _id
  full_name
  email
  phone
  avatar
  expenses
  orders_count
  created_at
`;

const CUSTOMER_DETAIL_FIELDS = `
  id
  _id
  full_name
  first_name
  last_name
  email
  phone
  avatar
  expenses
  orders_count
  accepts_marketing
  notes
  tags
  shipping_address {
    first_name
    last_name
    line1
    line2
    city
    country
    zip
    state
    phone
  }
  created_at
  updated_at
`;

const listCustomers = tool({
  name: "lf_list_customers",
  description: "List customers (contacts) with pagination. Supports order_by and order_dir.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .default("order_by:id order_dir:desc")
      .describe("Filter/sort string. Supported: order_by, order_dir."),
    ...PaginationInput,
  }),
  handler: async (input, client) => {
    const variables: Record<string, unknown> = { query: input.query };
    if (input.first) variables.first = input.first;
    if (input.after) variables.after = input.after;

    return client.query(
      `query ListCustomers($first: Int, $after: String, $query: String!) {
        customers(query: $query, first: $first, after: $after) {
          edges {
            node { ${CUSTOMER_FIELDS} }
            cursor
          }
          pageInfo { endCursor hasNextPage }
        }
      }`,
      variables,
    );
  },
});

const getCustomer = tool({
  name: "lf_get_customer",
  description: "Retrieve a single customer by their ID with full details.",
  inputSchema: z.object({
    id: z.string().describe("The customer ID."),
  }),
  handler: async (input, client) => {
    return client.query(
      `query GetCustomer($id: ID!) {
        node(id: $id) {
          ... on Customer { ${CUSTOMER_DETAIL_FIELDS} }
        }
      }`,
      { id: input.id },
    );
  },
});

/* -------------------------------------------------------------------------- */
/*  Account settings                                                          */
/* -------------------------------------------------------------------------- */

const getAccountSettings = tool({
  name: "lf_account_settings",
  description: "Retrieve account settings including tracking pixels (Facebook, TikTok, Snapchat).",
  inputSchema: z.object({}),
  handler: async (_input, client) => {
    return client.query(
      `query AccountSettings {
        account {
          account_name
          email
          store_currency
          store_currency_format
          timezone
          facebook_pixels { label value }
          snapchat_pixels { label value }
          tiktok_pixels { label value }
          pinterest_pixels { label value }
          google_ads_pixels { label value }
        }
      }`,
    );
  },
});

/* -------------------------------------------------------------------------- */
/*  Aggregation: summarize orders (client-side analytics)                     */
/* -------------------------------------------------------------------------- */

interface OrderNode {
  _id: number;
  total: number;
  subtotal: number;
  shipping: number;
  currency: string;
  fulfillment_status: string;
  financial_status: string;
  funnel_id: string | null;
  customer?: { full_name?: string };
  cancelled_at: string | null;
  created_at: string;
  test: boolean;
}

const summarizeOrders = tool({
  name: "lf_summarize_orders",
  description:
    "Aggregate order analytics with date filtering. Fetches orders and computes: total orders, total sales, average order value, breakdown by fulfillment status, financial status, and currency. Supports exact date range filtering via since_date and until_date (ISO format YYYY-MM-DD). Use product_id in the query param to filter by product.",
  inputSchema: z.object({
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(50)
      .describe("Max pages to fetch (100 orders per page). Default 50 = up to 5000 orders."),
    query: z
      .string()
      .optional()
      .default("order_by:created_at order_dir:desc")
      .describe("Filter/sort string passed to the orders query. Use product_id:<id> to filter by product."),
    since_date: z
      .string()
      .optional()
      .describe("Only include orders created on or after this date (ISO format YYYY-MM-DD, e.g. '2026-04-01')."),
    until_date: z
      .string()
      .optional()
      .describe("Only include orders created on or before this date (ISO format YYYY-MM-DD, e.g. '2026-05-21')."),
  }),
  handler: async (input, client) => {
    const allOrders: OrderNode[] = [];
    let cursor: string | undefined;
    let page = 0;
    const maxPages = input.max_pages ?? 50;
    const sinceDate = input.since_date ? new Date(input.since_date) : null;
    const untilDate = input.until_date ? new Date(input.until_date + "T23:59:59") : null;
    let reachedBeforeSince = false;

    while (page < maxPages && !reachedBeforeSince) {
      const variables: Record<string, unknown> = {
        query: input.query ?? "order_by:created_at order_dir:desc",
        first: 100,
      };
      if (cursor) variables.after = cursor;

      const result = await client.query<{ orders: Connection<OrderNode> }>(
        `query SummarizeOrders($first: Int, $after: String, $query: String!) {
          orders(query: $query, first: $first, after: $after) {
            edges {
              node {
                _id
                total
                subtotal
                shipping
                currency
                fulfillment_status
                financial_status
                funnel_id
                customer { full_name }
                cancelled_at
                created_at(format: "YYYY-MM-DDTHH:mm:ss")
                test
              }
              cursor
            }
            pageInfo { endCursor hasNextPage }
          }
        }`,
        variables,
      );

      const edges = result.orders.edges;
      if (!edges.length) break;

      for (const edge of edges) {
        const order = edge.node;
        if (order.test) continue;

        const orderDate = new Date(order.created_at);
        if (sinceDate && orderDate < sinceDate) {
          reachedBeforeSince = true;
          break;
        }
        if (untilDate && orderDate > untilDate) continue;

        allOrders.push(order);
      }

      if (!result.orders.pageInfo.hasNextPage) break;
      cursor = result.orders.pageInfo.endCursor ?? undefined;
      page++;
    }

    const totalOrders = allOrders.length;
    const totalSales = allOrders.reduce((sum, o) => sum + (o.total ?? 0), 0);
    const totalSubtotal = allOrders.reduce((sum, o) => sum + (o.subtotal ?? 0), 0);
    const totalShipping = allOrders.reduce((sum, o) => sum + (o.shipping ?? 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;

    const byFulfillment: Record<string, number> = {};
    const byFinancial: Record<string, number> = {};
    const byCurrency: Record<string, { orders: number; sales: number }> = {};
    const byFunnel: Record<string, { orders: number; sales: number }> = {};
    let cancelledCount = 0;

    for (const order of allOrders) {
      const fs = order.fulfillment_status || "unknown";
      byFulfillment[fs] = (byFulfillment[fs] ?? 0) + 1;

      const fin = order.financial_status || "unknown";
      byFinancial[fin] = (byFinancial[fin] ?? 0) + 1;

      const cur = order.currency || "unknown";
      const curEntry = byCurrency[cur] ?? { orders: 0, sales: 0 };
      curEntry.orders++;
      curEntry.sales += order.total ?? 0;
      byCurrency[cur] = curEntry;

      const funnelId = order.funnel_id || "unknown";
      const funnelEntry = byFunnel[funnelId] ?? { orders: 0, sales: 0 };
      funnelEntry.orders++;
      funnelEntry.sales += order.total ?? 0;
      byFunnel[funnelId] = funnelEntry;

      if (order.cancelled_at) cancelledCount++;
    }

    const oldestCreatedAt = allOrders.length > 0
      ? allOrders[allOrders.length - 1].created_at
      : null;
    const newestCreatedAt = allOrders.length > 0
      ? allOrders[0].created_at
      : null;

    return {
      total_orders: totalOrders,
      total_sales: Math.round(totalSales * 100) / 100,
      total_subtotal: Math.round(totalSubtotal * 100) / 100,
      total_shipping: Math.round(totalShipping * 100) / 100,
      average_order_value: Math.round(avgOrderValue * 100) / 100,
      cancelled_orders: cancelledCount,
      by_fulfillment_status: byFulfillment,
      by_financial_status: byFinancial,
      by_currency: byCurrency,
      by_funnel: byFunnel,
      oldest_order_created_at: oldestCreatedAt,
      newest_order_created_at: newestCreatedAt,
      pages_fetched: page + 1,
      date_filter: {
        since: input.since_date ?? null,
        until: input.until_date ?? null,
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Fetch all orders (paginated, with date & product filter)                  */
/* -------------------------------------------------------------------------- */

const fetchAllOrders = tool({
  name: "lf_fetch_all_orders",
  description:
    "Fetch ALL orders matching filters, paginating automatically. Returns every order with full details including funnel_id, customer phone, and ISO timestamps. Use this when you need the complete list of orders (not just a summary). Supports date range and product filtering.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .default("order_by:created_at order_dir:desc")
      .describe("Filter/sort string. Use product_id:<id> to filter by product. Example: 'order_by:created_at order_dir:desc product_id:prod_abc123'."),
    since_date: z
      .string()
      .optional()
      .describe("Only include orders created on or after this date (ISO YYYY-MM-DD)."),
    until_date: z
      .string()
      .optional()
      .describe("Only include orders created on or before this date (ISO YYYY-MM-DD)."),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe("Max pages (100 orders/page). Default 100 = up to 10,000 orders."),
    include_test: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include test orders (default: false)."),
  }),
  handler: async (input, client) => {
    interface FullOrderNode {
      id: string;
      _id: number;
      name: string;
      total: number;
      subtotal: number;
      shipping: number;
      currency: string;
      fulfillment_status: string;
      financial_status: string;
      funnel_id: string | null;
      customer: { id: string; _id: number; full_name: string; email: string; phone: string } | null;
      shipping_address: { first_name: string; last_name: string; line1: string; line2: string; city: string; country: string; zip: string; phone: string } | null;
      items: { _id: number; title: string; sku: string; price: number; product_id: string }[];
      cancelled_at: string | null;
      test: boolean;
      created_at: string;
      updated_at: string;
    }

    const allOrders: FullOrderNode[] = [];
    let cursor: string | undefined;
    let page = 0;
    const maxPages = input.max_pages ?? 100;
    const sinceDate = input.since_date ? new Date(input.since_date) : null;
    const untilDate = input.until_date ? new Date(input.until_date + "T23:59:59") : null;
    let reachedBeforeSince = false;

    while (page < maxPages && !reachedBeforeSince) {
      const variables: Record<string, unknown> = {
        query: input.query ?? "order_by:created_at order_dir:desc",
        first: 100,
      };
      if (cursor) variables.after = cursor;

      const result = await client.query<{ orders: Connection<FullOrderNode> }>(
        `query FetchAllOrders($first: Int, $after: String, $query: String!) {
          orders(query: $query, first: $first, after: $after) {
            edges {
              node {
                id
                _id
                name
                total
                subtotal
                shipping
                currency
                fulfillment_status
                financial_status
                funnel_id
                customer {
                  id
                  _id
                  full_name
                  email
                  phone
                }
                shipping_address {
                  first_name
                  last_name
                  line1
                  line2
                  city
                  country
                  zip
                  phone
                }
                items {
                  ... on VariantSnapshot {
                    _id
                    title
                    sku
                    price
                    product_id
                  }
                  ... on OrderBumpSnapshot {
                    _id
                    title
                    sku
                    price
                    product_id
                  }
                }
                cancelled_at
                test
                created_at(format: "YYYY-MM-DDTHH:mm:ss")
                updated_at(format: "YYYY-MM-DDTHH:mm:ss")
              }
              cursor
            }
            pageInfo { endCursor hasNextPage }
          }
        }`,
        variables,
      );

      const edges = result.orders.edges;
      if (!edges.length) break;

      for (const edge of edges) {
        const order = edge.node;
        if (!input.include_test && order.test) continue;

        const orderDate = new Date(order.created_at);
        if (sinceDate && orderDate < sinceDate) {
          reachedBeforeSince = true;
          break;
        }
        if (untilDate && orderDate > untilDate) continue;

        allOrders.push(order);
      }

      if (!result.orders.pageInfo.hasNextPage) break;
      cursor = result.orders.pageInfo.endCursor ?? undefined;
      page++;
    }

    return {
      total_count: allOrders.length,
      date_filter: { since: input.since_date ?? null, until: input.until_date ?? null },
      orders: allOrders,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Raw GraphQL query (escape hatch)                                          */
/* -------------------------------------------------------------------------- */

const rawQuery = tool({
  name: "lf_raw_query",
  description:
    "Execute an arbitrary GraphQL query against the Lightfunnels API. Use this as an escape hatch for queries not covered by the other tools.",
  inputSchema: z.object({
    query: z.string().describe("The GraphQL query string."),
    variables: z
      .record(z.unknown())
      .optional()
      .describe("Optional variables object for the query."),
  }),
  handler: async (input, client) => {
    return client.query(input.query, input.variables);
  },
});

/* -------------------------------------------------------------------------- */
/*  Export all tools                                                           */
/* -------------------------------------------------------------------------- */

export const tools: ToolDef[] = [
  listOrders,
  getOrder,
  listProducts,
  getProduct,
  listFunnels,
  getFunnel,
  listCustomers,
  getCustomer,
  getAccountSettings,
  summarizeOrders,
  fetchAllOrders,
  rawQuery,
];
