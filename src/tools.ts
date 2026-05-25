/**
 * Tool definitions for the Lightfunnels MCP server.
 *
 * Each tool maps to one or more GraphQL queries against
 * https://services.lightfunnels.com/api/v2
 * documented at https://developer.lightfunnels.com
 */

import { z } from "zod";
import type { LfClient } from "./client.js";
import {
  buildExport,
  type ExportFormat,
  type ExportOrder,
} from "./exporter.js";
import type { ExportPublisher } from "./publisher.js";

/* -------------------------------------------------------------------------- */
/*  Phone number normalization                                                */
/* -------------------------------------------------------------------------- */

const COUNTRY_CODES: Record<string, { code: string; localLen: number }> = {
  SA: { code: "966", localLen: 9 },
  AE: { code: "971", localLen: 9 },
  KW: { code: "965", localLen: 8 },
  BH: { code: "973", localLen: 8 },
  QA: { code: "974", localLen: 8 },
  OM: { code: "968", localLen: 8 },
  EG: { code: "20", localLen: 10 },
  MA: { code: "212", localLen: 9 },
  DZ: { code: "213", localLen: 9 },
  TN: { code: "216", localLen: 8 },
  JO: { code: "962", localLen: 9 },
  IQ: { code: "964", localLen: 10 },
  LB: { code: "961", localLen: 8 },
};

const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  "SAUDI ARABIA": "SA",
  "UNITED ARAB EMIRATES": "AE",
  "KUWAIT": "KW",
  "BAHRAIN": "BH",
  "QATAR": "QA",
  "OMAN": "OM",
  "EGYPT": "EG",
  "MOROCCO": "MA",
  "ALGERIA": "DZ",
  "TUNISIA": "TN",
  "JORDAN": "JO",
  "IRAQ": "IQ",
  "LEBANON": "LB",
  // ISO 3166-1 alpha-3 codes
  "SAU": "SA",
  "ARE": "AE",
  "KWT": "KW",
  "BHR": "BH",
  "QAT": "QA",
  "OMN": "OM",
  "EGY": "EG",
  "MAR": "MA",
  "DZA": "DZ",
  "TUN": "TN",
  "JOR": "JO",
  "IRQ": "IQ",
  "LBN": "LB",
};

// Unicode bidi/format control chars commonly pasted around RTL phone numbers
// (LRE/RLE/PDF/LRM/RLM/ZWSP/BOM/WJ). Stripped along with whitespace.
const PHONE_STRIP_CHARS = /[\s\-.()+/,;_\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

function normalizePhone(raw: string | null | undefined, countryCode?: string): string {
  if (!raw) return "";
  // Strip whitespace, common separators (- . ( ) + / , ; _), and unicode
  // bidi/format control chars that frequently wrap pasted phone numbers.
  let phone = raw.replace(PHONE_STRIP_CHARS, "");
  // If it's not digits (e.g. Arabic text or unparseable), return as-is
  if (!/^\d+$/.test(phone)) return raw;

  // Strip leading zeros (handles both "0XX" and "00XX" prefixes)
  phone = phone.replace(/^0+/, "");

  const rawCountry = countryCode?.toUpperCase();
  const country = rawCountry
    ? COUNTRY_CODES[rawCountry] ? rawCountry : COUNTRY_NAME_TO_ISO[rawCountry] ?? rawCountry
    : undefined;
  const info = country ? COUNTRY_CODES[country] : undefined;

  if (info) {
    const { code, localLen } = info;

    // Strip duplicated country code prefixes (e.g. "966966555...")
    while (phone.startsWith(code + code)) {
      phone = phone.slice(code.length);
    }

    // If starts with country code already, extract and validate local part
    if (phone.startsWith(code)) {
      const local = phone.slice(code.length).replace(/^0+/, "");
      if (local.length === localLen) {
        return "+" + code + local;
      }
      // Local part length doesn't match — return best-effort with code
      return "+" + code + local;
    }

    // Local number without country code
    if (phone.length === localLen) {
      return "+" + code + phone;
    }
    // Local with extra leading zero
    if (phone.length === localLen + 1 && phone.startsWith("0")) {
      return "+" + code + phone.slice(1);
    }

    // Number doesn't match expected local length — return with + prefix only
    // (don't blindly prepend country code to malformed numbers)
    return "+" + phone;
  }

  // No country info — just return digits without leading zeros, with + prefix
  return "+" + phone;
}

interface OrderWithPhone {
  customer?: { phone?: string; [k: string]: unknown } | null;
  shipping_address?: { phone?: string; country?: string; [k: string]: unknown } | null;
  [k: string]: unknown;
}

function normalizeOrderPhones<T extends OrderWithPhone>(order: T): T {
  const country = (order.shipping_address?.country as string) || undefined;
  if (order.customer?.phone) {
    (order as Record<string, unknown>)._raw_customer_phone = order.customer.phone;
    order.customer.phone = normalizePhone(order.customer.phone, country);
  }
  if (order.shipping_address?.phone) {
    (order as Record<string, unknown>)._raw_shipping_phone = order.shipping_address.phone;
    order.shipping_address.phone = normalizePhone(order.shipping_address.phone, country);
  }
  return order;
}

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
  shipping_address {
    country
    phone
  }
  utm {
    k
    v
  }
  checkout {
    funnel {
      name
      slug
      preferred_domain {
        name
      }
    }
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
  utm {
    k
    v
  }
  checkout {
    funnel {
      name
      slug
      preferred_domain {
        name
      }
    }
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

    const result = await client.query<{ orders: Connection<OrderWithPhone> }>(
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
    for (const edge of result.orders.edges) {
      normalizeOrderPhones(edge.node);
    }
    return result;
  },
});

const getOrder = tool({
  name: "lf_get_order",
  description: "Retrieve a single order by its ID with full details including line items and shipping address.",
  inputSchema: z.object({
    id: z.string().describe("The order ID (e.g. 'order_T3JkZXI6MTgyNTE0')."),
  }),
  handler: async (input, client) => {
    const result = await client.query<{ node: OrderWithPhone }>(
      `query GetOrder($id: ID!) {
        node(id: $id) {
          ... on Order { ${ORDER_DETAIL_FIELDS} }
        }
      }`,
      { id: input.id },
    );
    normalizeOrderPhones(result.node);
    return result;
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
  utm?: { k: string; v: string }[] | null;
  checkout?: { funnel?: { name: string; slug: string; preferred_domain?: { name: string } | null } | null } | null;
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
                utm { k v }
                checkout {
                  funnel {
                    name
                    slug
                    preferred_domain { name }
                  }
                }
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
    const byFunnel: Record<string, { orders: number; sales: number; url: string }> = {};
    const bySource: Record<string, { orders: number; sales: number }> = {};
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

      // Funnel breakdown with URL
      const funnel = order.checkout?.funnel;
      const funnelName = funnel?.name || order.funnel_id || "unknown";
      const funnelUrl = funnel?.preferred_domain?.name && funnel?.slug
        ? `https://${funnel.preferred_domain.name}/${funnel.slug}`
        : "";
      const funnelEntry = byFunnel[funnelName] ?? { orders: 0, sales: 0, url: funnelUrl };
      funnelEntry.orders++;
      funnelEntry.sales += order.total ?? 0;
      byFunnel[funnelName] = funnelEntry;

      // UTM source breakdown
      const utmSource = order.utm?.find(u => u.k === "source")?.v || "direct";
      const sourceEntry = bySource[utmSource] ?? { orders: 0, sales: 0 };
      sourceEntry.orders++;
      sourceEntry.sales += order.total ?? 0;
      bySource[utmSource] = sourceEntry;

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
      by_source: bySource,
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
/*  Fetch orders in fast cursor-based chunks                                  */
/* -------------------------------------------------------------------------- */

const FETCH_ORDER_GQL = `query FetchOrders($first: Int, $after: String, $query: String!) {
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
        utm {
          k
          v
        }
        checkout {
          link
          funnel {
            name
            slug
            preferred_domain {
              name
            }
          }
        }
        custom
        cancelled_at
        test
        created_at(format: "YYYY-MM-DDTHH:mm:ss")
        updated_at(format: "YYYY-MM-DDTHH:mm:ss")
      }
      cursor
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

interface FetchOrderNode {
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
  utm: { k: string; v: string }[] | null;
  checkout: { link: string | null; funnel: { name: string; slug: string; preferred_domain: { name: string } | null } | null } | null;
  custom: Record<string, unknown> | null;
  cancelled_at: string | null;
  test: boolean;
  created_at: string;
  updated_at: string;
}

const fetchAllOrders = tool({
  name: "lf_fetch_all_orders",
  description:
    "Fetch one batch of orders with full details using cursor-based pagination. **This does NOT return all orders in a single call** — pass `next_cursor` from the previous response to fetch the next batch. Includes funnel URL, UTM attribution, normalized phone numbers. For dashboards/summaries use lf_summarize_orders; for full exports of 100s+ orders into a spreadsheet/CSV/JSONL file, use lf_export_orders instead — it paginates server-side and returns a downloadable file URL so order data never has to flow through the chat channel.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .default("order_by:created_at order_dir:desc")
      .describe("Filter/sort string. Use product_id:<id> to filter by product. Example: 'order_by:created_at order_dir:desc product_id:prod_abc123'."),
    since_date: z
      .string()
      .optional()
      .describe("Only include orders created on or after this date (ISO YYYY-MM-DD). Orders before this date are excluded and pagination stops."),
    until_date: z
      .string()
      .optional()
      .describe("Only include orders created on or before this date (ISO YYYY-MM-DD)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(50)
      .describe("Orders per batch (default 50, max 100). Use 50 for sheets, 100 for dashboards."),
    cursor: z
      .string()
      .optional()
      .describe("Cursor from previous response's next_cursor to continue pagination. Omit for first call."),
    include_test: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include test orders (default: false)."),
  }),
  handler: async (input, client) => {
    const orders: FetchOrderNode[] = [];
    const limit = input.limit ?? 50;
    const sinceDate = input.since_date ? new Date(input.since_date) : null;
    const untilDate = input.until_date ? new Date(input.until_date + "T23:59:59") : null;
    let apiCursor: string | undefined = input.cursor;
    let reachedEnd = false;
    let reachedBeforeSince = false;

    // Fetch from API in pages until we have enough orders or hit the date boundary
    while (orders.length < limit && !reachedEnd && !reachedBeforeSince) {
      const variables: Record<string, unknown> = {
        query: input.query ?? "order_by:created_at order_dir:desc",
        first: 100,
      };
      if (apiCursor) variables.after = apiCursor;

      const result = await client.query<{ orders: Connection<FetchOrderNode> }>(
        FETCH_ORDER_GQL,
        variables,
      );

      const edges = result.orders.edges;
      if (!edges.length) {
        reachedEnd = true;
        break;
      }

      for (const edge of edges) {
        if (orders.length >= limit) break;
        const order = edge.node;
        if (!input.include_test && order.test) continue;

        const orderDate = new Date(order.created_at);
        if (sinceDate && orderDate < sinceDate) {
          reachedBeforeSince = true;
          break;
        }
        if (untilDate && orderDate > untilDate) continue;

        normalizeOrderPhones(order as unknown as OrderWithPhone);
        orders.push(order);
      }

      if (!result.orders.pageInfo.hasNextPage) {
        reachedEnd = true;
      } else {
        apiCursor = result.orders.pageInfo.endCursor ?? undefined;
      }
    }

    const done = reachedEnd || reachedBeforeSince;

    return {
      returned: orders.length,
      has_more: !done,
      next_cursor: !done ? apiCursor ?? null : null,
      date_filter: { since: input.since_date ?? null, until: input.until_date ?? null },
      orders,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Export orders to a downloadable file                                      */
/* -------------------------------------------------------------------------- */

const DEFAULT_EXPORT_MAX_ORDERS = 10000;
const EXPORT_PAGE_SIZE = 100;

function buildExportOrdersTool(publisher: ExportPublisher | null): ToolDef {
  return tool({
    name: "lf_export_orders",
    description:
      "Export orders to a downloadable file (xlsx, csv, or jsonl). The MCP server paginates the Lightfunnels API internally, builds the file, and returns ONLY a small JSON response with a `file_url` you can hand back to the user. The order rows themselves never flow through the chat channel — this avoids token bloat and truncation when exporting hundreds of orders. Supports the same `query`, `since_date`, `until_date`, and `include_test` filters as `lf_fetch_all_orders`. The xlsx format produces up to 4 sheets (orders / line_items / utm / raw_json); csv and jsonl produce a single flat file with optional `items_json` / `utm_json` / `raw_json` columns. Phone numbers are normalized by default.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .default("order_by:created_at order_dir:desc")
        .describe(
          "Filter/sort string passed straight to the Lightfunnels API. Use product_id:<id> to filter by product. Example: 'order_by:created_at order_dir:desc product_id:prod_abc123'.",
        ),
      since_date: z
        .string()
        .optional()
        .describe(
          "Only include orders created on or after this date (ISO YYYY-MM-DD). Pagination stops once older orders are encountered.",
        ),
      until_date: z
        .string()
        .optional()
        .describe(
          "Only include orders created on or before this date (ISO YYYY-MM-DD).",
        ),
      include_test: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include test orders (default: false)."),
      format: z
        .enum(["xlsx", "csv", "jsonl"])
        .optional()
        .default("xlsx")
        .describe(
          "Output file format. xlsx = multi-sheet Excel (orders + line_items + utm + raw_json). csv = single flat sheet with optional *_json columns. jsonl = one order per line.",
        ),
      include_items: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Include line items. In xlsx this becomes a `line_items` sheet; in csv it becomes an `items_json` column.",
        ),
      include_utm: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Include UTM attribution. In xlsx this becomes a `utm` sheet; in csv it becomes a `utm_json` column.",
        ),
      include_raw_json: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include the raw order JSON as an additional sheet (xlsx) or column (csv). Adds substantial size — disabled by default.",
        ),
      normalize_phones: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Normalize customer + shipping phone numbers to canonical digits-only form prefixed with the country code (e.g. 9665XXXXXXXX). Strips spaces, dashes, dots, parentheses, plus signs, slashes, commas, semicolons, underscores, and Unicode bidi/format control characters. Strips leading zeros (so '00966XXX' and '0XX' both work). For supported countries (SA, AE, KW, BH, QA, OM, EG, MA, DZ, TN, JO, IQ, LB) the country code is added when missing.",
        ),
      max_orders: z
        .number()
        .int()
        .min(1)
        .max(50000)
        .optional()
        .default(DEFAULT_EXPORT_MAX_ORDERS)
        .describe(
          `Safety cap on the total number of orders fetched (default ${DEFAULT_EXPORT_MAX_ORDERS}, max 50000).`,
        ),
      file_name: z
        .string()
        .optional()
        .describe(
          "Optional base filename (without extension). Defaults to `lightfunnel_orders_<filters>_<timestamp>`.",
        ),
    }),
    handler: async (input, client) => {
      if (!publisher) {
        throw new Error(
          "lf_export_orders is not available: no file publisher is configured. " +
            "This typically means the server was started in stdio mode without a writable temp directory, or the HTTP file store failed to initialize.",
        );
      }

      const sinceDate = input.since_date ? new Date(input.since_date) : null;
      const untilDate = input.until_date
        ? new Date(input.until_date + "T23:59:59")
        : null;
      if (sinceDate && Number.isNaN(sinceDate.getTime())) {
        throw new Error(`Invalid since_date: ${input.since_date}`);
      }
      if (untilDate && Number.isNaN(untilDate.getTime())) {
        throw new Error(`Invalid until_date: ${input.until_date}`);
      }

      const orders: FetchOrderNode[] = [];
      const maxOrders = input.max_orders ?? DEFAULT_EXPORT_MAX_ORDERS;
      let apiCursor: string | undefined;
      let pagesFetched = 0;
      let reachedEnd = false;
      let reachedBeforeSince = false;

      while (
        orders.length < maxOrders &&
        !reachedEnd &&
        !reachedBeforeSince
      ) {
        const variables: Record<string, unknown> = {
          query: input.query ?? "order_by:created_at order_dir:desc",
          first: EXPORT_PAGE_SIZE,
        };
        if (apiCursor) variables.after = apiCursor;

        const result = await client.query<{
          orders: Connection<FetchOrderNode>;
        }>(FETCH_ORDER_GQL, variables);
        pagesFetched += 1;

        const edges = result.orders.edges;
        if (!edges.length) {
          reachedEnd = true;
          break;
        }

        for (const edge of edges) {
          if (orders.length >= maxOrders) break;
          const order = edge.node;
          if (!input.include_test && order.test) continue;

          const orderDate = new Date(order.created_at);
          if (sinceDate && orderDate < sinceDate) {
            reachedBeforeSince = true;
            break;
          }
          if (untilDate && orderDate > untilDate) continue;

          if (input.normalize_phones) {
            normalizeOrderPhones(order as unknown as OrderWithPhone);
          }
          orders.push(order);
        }

        if (!result.orders.pageInfo.hasNextPage) {
          reachedEnd = true;
        } else {
          apiCursor = result.orders.pageInfo.endCursor ?? undefined;
        }
      }

      const truncated =
        orders.length >= maxOrders && !reachedEnd && !reachedBeforeSince;

      const built = await buildExport(orders as unknown as ExportOrder[], {
        format: input.format as ExportFormat,
        includeItems: input.include_items,
        includeUtm: input.include_utm,
        includeRawJson: input.include_raw_json,
      });

      const fileBase = input.file_name ?? buildDefaultFileName(input.query, input.since_date, input.until_date);
      const fileName = `${fileBase}.${built.fileExtension}`;
      const published = await publisher.publish({
        content: built.buffer,
        contentType: built.contentType,
        fileName,
      });

      const sheets: string[] = ["orders"];
      if (input.format === "xlsx") {
        if (input.include_items) sheets.push("line_items");
        if (input.include_utm) sheets.push("utm");
        const hasCustom = orders.some(
          (o) => o.custom && Object.keys(o.custom).length > 0,
        );
        if (hasCustom) sheets.push("attributes");
        if (input.include_raw_json) sheets.push("raw_json");
      }

      return {
        file_url: published.url,
        file_name: fileName,
        total_orders: orders.length,
        format: input.format,
        sheets,
        size_bytes: published.sizeBytes,
        truncated,
        pages_fetched: pagesFetched,
        date_filter: {
          since: input.since_date ?? null,
          until: input.until_date ?? null,
        },
      };
    },
  });
}

function buildDefaultFileName(
  query: string | undefined,
  since: string | undefined,
  until: string | undefined,
): string {
  const productMatch = query?.match(/product_id:([A-Za-z0-9_-]+)/);
  const productPart = productMatch ? `_${productMatch[1]}` : "";
  const sincePart = since ? `_${since}` : "";
  const untilPart = until ? `_${until}` : "";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `lightfunnel_orders${productPart}${sincePart}${untilPart}_${ts}`;
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
/*  Export all tools                                                          */
/* -------------------------------------------------------------------------- */

export interface ToolDeps {
  /** Optional file publisher enabling the lf_export_orders tool. */
  publisher?: ExportPublisher | null;
}

export function buildTools(deps: ToolDeps = {}): ToolDef[] {
  return [
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
    buildExportOrdersTool(deps.publisher ?? null),
    rawQuery,
  ];
}
