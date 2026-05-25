/**
 * In-memory file store with total-size cap, used to serve generated
 * export files via signed-URL-style random IDs. Files never expire —
 * they remain available as long as the server process is running (or
 * until LRU eviction reclaims space for newer files).
 *
 * The HTTP entrypoint mounts a `GET /files/:id/:filename` route that
 * pulls bytes from this store. The random 32-byte ID in the URL acts
 * as a bearer token — the ID is the secret.
 *
 * For the stdio entrypoint there is no HTTP server, so `lf_export_orders`
 * falls back to writing the file to a temp directory and returning a
 * `file://` URL instead of using this store.
 */

import crypto from "node:crypto";
import type { Request, Response } from "express";
import type {
  ExportPublisher,
  PublishInput,
  PublishResult,
} from "./publisher.js";

export interface FileStoreOptions {
  /** Hard cap on total bytes kept in memory. Oldest entries evicted (LRU). */
  maxTotalBytes?: number;
  /** Hard cap on a single file's size. */
  maxFileBytes?: number;
  /** Public base URL used to build absolute file URLs. */
  baseUrl: URL;
}

interface Entry {
  id: string;
  fileName: string;
  contentType: string;
  buffer: Buffer;
  createdAt: number;
}

const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

export class HttpFileStore implements ExportPublisher {
  private readonly entries = new Map<string, Entry>();
  private readonly maxTotalBytes: number;
  private readonly maxFileBytes: number;
  private readonly baseUrl: URL;
  private totalBytes = 0;

  constructor(opts: FileStoreOptions) {
    this.baseUrl = opts.baseUrl;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  publish(input: PublishInput): PublishResult {
    const buffer =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : input.content;

    if (buffer.byteLength > this.maxFileBytes) {
      throw new Error(
        `Export file (${buffer.byteLength} bytes) exceeds per-file limit (${this.maxFileBytes} bytes). ` +
          "Lower max_orders or split the export.",
      );
    }

    this.evictUntilFits(buffer.byteLength);

    const id = crypto.randomBytes(32).toString("base64url");
    const safeName = sanitizeFileName(input.fileName);
    const entry: Entry = {
      id,
      fileName: safeName,
      contentType: input.contentType,
      buffer,
      createdAt: Date.now(),
    };
    this.entries.set(id, entry);
    this.totalBytes += buffer.byteLength;

    const url = new URL(
      `/files/${id}/${encodeURIComponent(safeName)}`,
      this.baseUrl,
    ).toString();

    return {
      url,
      sizeBytes: buffer.byteLength,
      id,
    };
  }

  /** Serve a stored file via the supplied Express request/response pair. */
  serve = (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(404).type("text/plain").send("Not found.");
      return;
    }
    const entry = this.entries.get(id);
    if (!entry) {
      res.status(404).type("text/plain").send("Not found.");
      return;
    }
    res.setHeader("Content-Type", entry.contentType);
    res.setHeader("Content-Length", entry.buffer.byteLength.toString());
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${entry.fileName}"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).end(entry.buffer);
  };

  private delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.buffer.byteLength;
  }

  private evictUntilFits(incomingBytes: number): void {
    if (incomingBytes > this.maxTotalBytes) return; // single-file check covers this
    while (this.totalBytes + incomingBytes > this.maxTotalBytes) {
      const oldestId = this.entries.keys().next().value;
      if (!oldestId) break;
      this.delete(oldestId);
    }
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "export.bin";
}
