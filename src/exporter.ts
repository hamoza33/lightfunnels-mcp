/**
 * Builders that turn an array of Lightfunnels order objects into a
 * downloadable file (xlsx, csv, jsonl). Used by the `lf_export_orders`
 * tool to ship 100s–1000s of rows out of the MCP channel as a single
 * file artifact instead of paginated JSON.
 *
 * Why this exists: shoving large paginated responses through the MCP
 * tool channel into ChatGPT both truncates and burns tokens. Producing
 * a file server-side and returning a download URL bypasses both.
 */

import ExcelJS from "exceljs";

/* -------------------------------------------------------------------------- */
/*  Order shape consumed by the exporter                                      */
/* -------------------------------------------------------------------------- */

export interface ExportOrderItem {
  _id?: number;
  title?: string;
  sku?: string;
  price?: number;
  product_id?: string;
  fulfillment_status?: string;
  financial_status?: string;
  tracking_number?: string;
  tracking_link?: string;
  carrier?: string;
}

export interface ExportShippingAddress {
  first_name?: string;
  last_name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  country?: string;
  zip?: string;
  phone?: string;
}

export interface ExportCustomer {
  id?: string;
  _id?: number;
  full_name?: string;
  email?: string;
  phone?: string;
}

export interface ExportOrder {
  id: string;
  _id?: number;
  name?: string;
  total?: number;
  subtotal?: number;
  shipping?: number;
  currency?: string;
  fulfillment_status?: string;
  financial_status?: string;
  funnel_id?: string | null;
  customer?: ExportCustomer | null;
  shipping_address?: ExportShippingAddress | null;
  items?: ExportOrderItem[];
  utm?: { k: string; v: string }[] | null;
  checkout?: {
    link?: string | null;
    funnel?: {
      name?: string;
      slug?: string;
      preferred_domain?: { name?: string } | null;
    } | null;
  } | null;
  custom?: Record<string, unknown> | null;
  cancelled_at?: string | null;
  test?: boolean;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export type ExportFormat = "xlsx" | "csv" | "jsonl";

export interface BuildExportOptions {
  format: ExportFormat;
  includeItems: boolean;
  includeUtm: boolean;
  includeRawJson: boolean;
}

export interface BuildExportResult {
  buffer: Buffer;
  contentType: string;
  fileExtension: "xlsx" | "csv" | "jsonl";
}

/* -------------------------------------------------------------------------- */
/*  Row projection                                                            */
/* -------------------------------------------------------------------------- */

const ORDER_COLUMNS: Array<{ key: string; header: string; width?: number }> = [
  { key: "id", header: "id", width: 28 },
  { key: "_id", header: "internal_id", width: 12 },
  { key: "name", header: "order_name", width: 14 },
  { key: "created_at", header: "created_at", width: 22 },
  { key: "updated_at", header: "updated_at", width: 22 },
  { key: "currency", header: "currency", width: 10 },
  { key: "total", header: "total", width: 12 },
  { key: "subtotal", header: "subtotal", width: 12 },
  { key: "shipping", header: "shipping", width: 12 },
  { key: "fulfillment_status", header: "fulfillment_status", width: 18 },
  { key: "financial_status", header: "financial_status", width: 18 },
  { key: "test", header: "test", width: 8 },
  { key: "cancelled_at", header: "cancelled_at", width: 22 },
  { key: "funnel_id", header: "funnel_id", width: 24 },
  { key: "funnel_name", header: "funnel_name", width: 24 },
  { key: "funnel_slug", header: "funnel_slug", width: 24 },
  { key: "funnel_domain", header: "funnel_domain", width: 28 },
  { key: "funnel_url", header: "funnel_url", width: 48 },
  { key: "customer_id", header: "customer_id", width: 24 },
  { key: "customer_full_name", header: "customer_full_name", width: 24 },
  { key: "customer_email", header: "customer_email", width: 28 },
  { key: "customer_phone", header: "customer_phone", width: 18 },
  { key: "shipping_first_name", header: "shipping_first_name", width: 18 },
  { key: "shipping_last_name", header: "shipping_last_name", width: 18 },
  { key: "shipping_line1", header: "shipping_line1", width: 28 },
  { key: "shipping_line2", header: "shipping_line2", width: 20 },
  { key: "shipping_city", header: "shipping_city", width: 18 },
  { key: "shipping_zip", header: "shipping_zip", width: 12 },
  { key: "shipping_country", header: "shipping_country", width: 10 },
  { key: "shipping_phone", header: "shipping_phone", width: 18 },
  { key: "items_count", header: "items_count", width: 10 },
  { key: "items_summary", header: "items_summary", width: 60 },
  { key: "utm_source", header: "utm_source", width: 18 },
  { key: "utm_medium", header: "utm_medium", width: 14 },
  { key: "utm_campaign", header: "utm_campaign", width: 36 },
  { key: "utm_id", header: "utm_id", width: 24 },
  { key: "custom_fields", header: "custom_fields", width: 60 },
];

interface FlatOrderRow {
  [k: string]: unknown;
}

function utmLookup(
  utm: { k: string; v: string }[] | null | undefined,
  key: string,
): string {
  if (!utm) return "";
  const entry = utm.find((u) => u.k === key);
  return entry?.v ?? "";
}

function buildFunnelUrl(order: ExportOrder): string {
  const checkoutLink = order.checkout?.link;
  if (checkoutLink) {
    try {
      const url = new URL(checkoutLink);
      url.search = "";
      return url.toString();
    } catch {
      // fall through to construct from parts
    }
  }
  const funnel = order.checkout?.funnel ?? null;
  const domain = funnel?.preferred_domain?.name?.trim() ?? "";
  const slug = funnel?.slug?.trim() ?? "";
  if (!domain) return "";
  return slug ? `https://${domain}/${slug}` : `https://${domain}`;
}

function flattenOrder(order: ExportOrder): FlatOrderRow {
  const funnel = order.checkout?.funnel ?? null;
  const customer = order.customer ?? null;
  const address = order.shipping_address ?? null;
  const items = order.items ?? [];
  const itemsSummary = items
    .map((it) => {
      const title = it.title ?? "";
      const sku = it.sku ? ` [${it.sku}]` : "";
      return `${title}${sku}`;
    })
    .filter(Boolean)
    .join(" | ");

  return {
    id: order.id,
    _id: order._id ?? "",
    name: order.name ?? "",
    created_at: order.created_at ?? "",
    updated_at: order.updated_at ?? "",
    currency: order.currency ?? "",
    total: order.total ?? "",
    subtotal: order.subtotal ?? "",
    shipping: order.shipping ?? "",
    fulfillment_status: order.fulfillment_status ?? "",
    financial_status: order.financial_status ?? "",
    test: order.test ?? false,
    cancelled_at: order.cancelled_at ?? "",
    funnel_id: order.funnel_id ?? "",
    funnel_name: funnel?.name ?? "",
    funnel_slug: funnel?.slug ?? "",
    funnel_domain: funnel?.preferred_domain?.name ?? "",
    funnel_url: buildFunnelUrl(order),
    customer_id: customer?.id ?? "",
    customer_full_name: customer?.full_name ?? "",
    customer_email: customer?.email ?? "",
    customer_phone: customer?.phone ?? "",
    shipping_first_name: address?.first_name ?? "",
    shipping_last_name: address?.last_name ?? "",
    shipping_line1: address?.line1 ?? "",
    shipping_line2: address?.line2 ?? "",
    shipping_city: address?.city ?? "",
    shipping_zip: address?.zip ?? "",
    shipping_country: address?.country ?? "",
    shipping_phone: address?.phone ?? "",
    items_count: items.length,
    items_summary: itemsSummary,
    utm_source: utmLookup(order.utm, "source"),
    utm_medium: utmLookup(order.utm, "medium"),
    utm_campaign: utmLookup(order.utm, "campaign"),
    utm_id: utmLookup(order.utm, "id"),
    custom_fields: order.custom && Object.keys(order.custom).length > 0
      ? JSON.stringify(order.custom)
      : "",
  };
}

/* -------------------------------------------------------------------------- */
/*  Public entrypoint                                                         */
/* -------------------------------------------------------------------------- */

export async function buildExport(
  orders: ExportOrder[],
  opts: BuildExportOptions,
): Promise<BuildExportResult> {
  switch (opts.format) {
    case "xlsx":
      return buildXlsx(orders, opts);
    case "csv":
      return buildCsv(orders, opts);
    case "jsonl":
      return buildJsonl(orders);
    default: {
      const exhaustive: never = opts.format;
      throw new Error(`Unsupported export format: ${String(exhaustive)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  XLSX (multi-sheet)                                                        */
/* -------------------------------------------------------------------------- */

async function buildXlsx(
  orders: ExportOrder[],
  opts: BuildExportOptions,
): Promise<BuildExportResult> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "lightfunnels-mcp";
  wb.created = new Date();

  // --- orders sheet --------------------------------------------------------
  const ordersSheet = wb.addWorksheet("orders");
  ordersSheet.columns = ORDER_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? 16,
  }));
  ordersSheet.getRow(1).font = { bold: true };
  for (const order of orders) {
    ordersSheet.addRow(flattenOrder(order));
  }

  // --- line_items sheet ----------------------------------------------------
  if (opts.includeItems) {
    const sheet = wb.addWorksheet("line_items");
    sheet.columns = [
      { header: "order_id", key: "order_id", width: 28 },
      { header: "order_name", key: "order_name", width: 14 },
      { header: "order_created_at", key: "order_created_at", width: 22 },
      { header: "item_index", key: "item_index", width: 10 },
      { header: "item_internal_id", key: "item_internal_id", width: 14 },
      { header: "title", key: "title", width: 36 },
      { header: "sku", key: "sku", width: 18 },
      { header: "price", key: "price", width: 12 },
      { header: "product_id", key: "product_id", width: 28 },
      { header: "fulfillment_status", key: "fulfillment_status", width: 18 },
      { header: "financial_status", key: "financial_status", width: 18 },
      { header: "tracking_number", key: "tracking_number", width: 22 },
      { header: "tracking_link", key: "tracking_link", width: 36 },
      { header: "carrier", key: "carrier", width: 16 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const order of orders) {
      const items = order.items ?? [];
      items.forEach((item, idx) => {
        sheet.addRow({
          order_id: order.id,
          order_name: order.name ?? "",
          order_created_at: order.created_at ?? "",
          item_index: idx,
          item_internal_id: item._id ?? "",
          title: item.title ?? "",
          sku: item.sku ?? "",
          price: item.price ?? "",
          product_id: item.product_id ?? "",
          fulfillment_status: item.fulfillment_status ?? "",
          financial_status: item.financial_status ?? "",
          tracking_number: item.tracking_number ?? "",
          tracking_link: item.tracking_link ?? "",
          carrier: item.carrier ?? "",
        });
      });
    }
  }

  // --- utm sheet -----------------------------------------------------------
  if (opts.includeUtm) {
    const sheet = wb.addWorksheet("utm");
    sheet.columns = [
      { header: "order_id", key: "order_id", width: 28 },
      { header: "order_name", key: "order_name", width: 14 },
      { header: "order_created_at", key: "order_created_at", width: 22 },
      { header: "utm_key", key: "k", width: 18 },
      { header: "utm_value", key: "v", width: 48 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const order of orders) {
      const pairs = order.utm ?? [];
      for (const pair of pairs) {
        sheet.addRow({
          order_id: order.id,
          order_name: order.name ?? "",
          order_created_at: order.created_at ?? "",
          k: pair.k ?? "",
          v: pair.v ?? "",
        });
      }
    }
  }

  // --- attributes sheet ----------------------------------------------------
  {
    const hasAnyCustom = orders.some(
      (o) => o.custom && Object.keys(o.custom).length > 0,
    );
    if (hasAnyCustom) {
      const sheet = wb.addWorksheet("attributes");
      sheet.columns = [
        { header: "order_id", key: "order_id", width: 28 },
        { header: "order_name", key: "order_name", width: 14 },
        { header: "order_created_at", key: "order_created_at", width: 22 },
        { header: "attribute_key", key: "attribute_key", width: 28 },
        { header: "attribute_value", key: "attribute_value", width: 60 },
      ];
      sheet.getRow(1).font = { bold: true };
      for (const order of orders) {
        const custom = order.custom;
        if (!custom) continue;
        for (const [key, value] of Object.entries(custom)) {
          sheet.addRow({
            order_id: order.id,
            order_name: order.name ?? "",
            order_created_at: order.created_at ?? "",
            attribute_key: key,
            attribute_value:
              typeof value === "string" ? value : JSON.stringify(value),
          });
        }
      }
    }
  }

  // --- raw_json sheet ------------------------------------------------------
  if (opts.includeRawJson) {
    const sheet = wb.addWorksheet("raw_json");
    sheet.columns = [
      { header: "order_id", key: "order_id", width: 28 },
      { header: "raw_json", key: "raw_json", width: 120 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const order of orders) {
      sheet.addRow({
        order_id: order.id,
        raw_json: JSON.stringify(order),
      });
    }
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
  return {
    buffer,
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileExtension: "xlsx",
  };
}

/* -------------------------------------------------------------------------- */
/*  CSV                                                                       */
/* -------------------------------------------------------------------------- */

function buildCsv(
  orders: ExportOrder[],
  opts: BuildExportOptions,
): BuildExportResult {
  const columns = ORDER_COLUMNS.map((c) => ({ key: c.key, header: c.header }));
  if (opts.includeItems) {
    columns.push({ key: "items_json", header: "items_json" });
  }
  if (opts.includeUtm) {
    columns.push({ key: "utm_json", header: "utm_json" });
  }
  if (opts.includeRawJson) {
    columns.push({ key: "raw_json", header: "raw_json" });
  }

  const lines: string[] = [];
  lines.push(columns.map((c) => csvEscape(c.header)).join(","));
  for (const order of orders) {
    const flat = flattenOrder(order);
    if (opts.includeItems) {
      flat.items_json = JSON.stringify(order.items ?? []);
    }
    if (opts.includeUtm) {
      flat.utm_json = JSON.stringify(order.utm ?? []);
    }
    if (opts.includeRawJson) {
      flat.raw_json = JSON.stringify(order);
    }
    lines.push(
      columns.map((c) => csvEscape(stringifyCell(flat[c.key]))).join(","),
    );
  }
  // RFC 4180 line endings + UTF-8 BOM so Excel opens with correct encoding
  const body = "\uFEFF" + lines.join("\r\n") + "\r\n";
  return {
    buffer: Buffer.from(body, "utf8"),
    contentType: "text/csv; charset=utf-8",
    fileExtension: "csv",
  };
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/*  JSONL                                                                     */
/* -------------------------------------------------------------------------- */

function buildJsonl(orders: ExportOrder[]): BuildExportResult {
  const body = orders.map((o) => JSON.stringify(o)).join("\n") + "\n";
  return {
    buffer: Buffer.from(body, "utf8"),
    contentType: "application/x-ndjson; charset=utf-8",
    fileExtension: "jsonl",
  };
}
