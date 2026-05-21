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
  fulfillment_status
  financial_status
  customer {
    id
    _id
    full_name
    email
    phone
  }
  cancelled_at
  date
  test
  created_at
  updated_at
`;

const ORDER_DETAIL_FIELDS = `
  id
  _id
  name
  total
  subtotal
  total_price
  total_shipping
  total_discounts
  total_tax
  fulfillment_status
  financial_status
  customer {
    id
    _id
    full_name
    email
    phone
    address1
    address2
    city
    country
    zip
  }
  line_items {
    id
    _id
    title
    quantity
    price
  }
  shipping_address {
    first_name
    last_name
    address1
    address2
    city
    country
    zip
    phone
  }
  note
  tags
  cancelled_at
  date
  test
  created_at
  updated_at
`;

const listOrders = tool({
  name: "lf_list_orders",
  description:
    "List orders with pagination. Supports filtering by status, financial_status, fulfillment_status, created_at, and product_id via the query string. Example query: 'order_by:id order_dir:desc status:active'.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .default("order_by:id order_dir:desc")
      .describe(
        "Filter/sort string. Supported params: order_by, order_dir, status, financial_status, fulfillment_status, created_at, product_id.",
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
  description
  notice_text
  price
  compare_at_price
  product_type
  images {
    id
    path(version: version1)
    title
  }
  variants {
    id
    _id
    title
    price
    sku
    weight
    inventory_quantity
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
  address1
  address2
  city
  country
  zip
  state
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
          facebook_pixels { label value }
          snapchat_pixels { label value }
          tiktok_pixels { label value }
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
  fulfillment_status: string;
  financial_status: string;
  customer?: { full_name?: string; country?: string };
  cancelled_at: string | null;
  created_at: string;
  date: string;
  test: boolean;
}

const summarizeOrders = tool({
  name: "lf_summarize_orders",
  description:
    "Aggregate order analytics over a date range. Fetches all orders in the range and computes: total orders, total sales, average order value, breakdown by fulfillment status and financial status. Set `bucket` to 'day', 'week', or 'month' to get a time-series. Automatically paginates through all results.",
  inputSchema: z.object({
    since: z
      .string()
      .optional()
      .describe("Start date (ISO 8601, e.g. '2025-01-01'). Defaults to 30 days ago."),
    until: z
      .string()
      .optional()
      .describe("End date (ISO 8601, e.g. '2025-01-31'). Defaults to today."),
    bucket: z
      .enum(["day", "week", "month"])
      .optional()
      .describe("Time bucket for series breakdown."),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe("Max pages to fetch (25 orders per page). Default 50 = up to 1250 orders."),
  }),
  handler: async (input, client) => {
    const now = new Date();
    const sinceDate = input.since
      ? new Date(input.since)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const untilDate = input.until ? new Date(input.until) : now;

    const allOrders: OrderNode[] = [];
    let cursor: string | undefined;
    let page = 0;
    const maxPages = input.max_pages ?? 50;

    while (page < maxPages) {
      const variables: Record<string, unknown> = {
        query: "order_by:id order_dir:desc",
        first: 25,
      };
      if (cursor) variables.after = cursor;

      const result = await client.query<{ orders: Connection<OrderNode> }>(
        `query SummarizeOrders($first: Int, $after: String, $query: String!) {
          orders(query: $query, first: $first, after: $after) {
            edges {
              node {
                _id
                total
                fulfillment_status
                financial_status
                customer { full_name }
                cancelled_at
                created_at
                date
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

      let reachedEnd = false;
      for (const edge of edges) {
        const order = edge.node;
        if (order.test) continue;

        const createdAt = new Date(order.created_at);
        if (createdAt < sinceDate) {
          reachedEnd = true;
          break;
        }
        if (createdAt <= untilDate) {
          allOrders.push(order);
        }
      }

      if (reachedEnd || !result.orders.pageInfo.hasNextPage) break;
      cursor = result.orders.pageInfo.endCursor ?? undefined;
      page++;
    }

    const totalOrders = allOrders.length;
    const totalSales = allOrders.reduce((sum, o) => sum + (o.total ?? 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;

    const byFulfillment: Record<string, number> = {};
    const byFinancial: Record<string, number> = {};
    let cancelledCount = 0;

    for (const order of allOrders) {
      const fs = order.fulfillment_status || "unknown";
      byFulfillment[fs] = (byFulfillment[fs] ?? 0) + 1;
      const fin = order.financial_status || "unknown";
      byFinancial[fin] = (byFinancial[fin] ?? 0) + 1;
      if (order.cancelled_at) cancelledCount++;
    }

    const summary: Record<string, unknown> = {
      period: {
        since: sinceDate.toISOString().slice(0, 10),
        until: untilDate.toISOString().slice(0, 10),
      },
      total_orders: totalOrders,
      total_sales: Math.round(totalSales * 100) / 100,
      average_order_value: Math.round(avgOrderValue * 100) / 100,
      cancelled_orders: cancelledCount,
      by_fulfillment_status: byFulfillment,
      by_financial_status: byFinancial,
      pages_fetched: page + 1,
    };

    if (input.bucket) {
      const series = buildTimeSeries(allOrders, input.bucket, sinceDate, untilDate);
      summary.series = series;
    }

    return summary;
  },
});

function bucketKey(date: Date, bucket: "day" | "week" | "month"): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  switch (bucket) {
    case "day":
      return `${y}-${m}-${d}`;
    case "week": {
      const day = date.getDay();
      const monday = new Date(date);
      monday.setDate(date.getDate() - ((day + 6) % 7));
      return `${monday.getFullYear()}-W${String(Math.ceil(((monday.getTime() - new Date(monday.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7)).padStart(2, "0")}`;
    }
    case "month":
      return `${y}-${m}`;
  }
}

function buildTimeSeries(
  orders: OrderNode[],
  bucket: "day" | "week" | "month",
  _since: Date,
  _until: Date,
): Array<{ period: string; orders: number; sales: number }> {
  const map = new Map<string, { orders: number; sales: number }>();

  for (const order of orders) {
    const key = bucketKey(new Date(order.created_at), bucket);
    const entry = map.get(key) ?? { orders: 0, sales: 0 };
    entry.orders++;
    entry.sales += order.total ?? 0;
    map.set(key, entry);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, data]) => ({
      period,
      orders: data.orders,
      sales: Math.round(data.sales * 100) / 100,
    }));
}

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
  rawQuery,
];
