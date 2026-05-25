/**
 * Shared interface for publishing a generated export file so the
 * `lf_export_orders` tool can return a download URL without having to
 * stuff the file's contents through the MCP channel.
 *
 * Two implementations live in the codebase:
 *   - HttpFileStore  (src/file-store.ts) — used by the HTTP entrypoint
 *   - DiskPublisher  (this file)         — used by the stdio entrypoint
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export interface PublishInput {
  /** Raw file bytes (or a UTF-8 string, which will be encoded). */
  content: Buffer | string;
  /** Suggested filename for downloads. */
  fileName: string;
  /** Content-Type header (used by HTTP store; informational for disk store). */
  contentType: string;
}

export interface PublishResult {
  /** Absolute URL clients can fetch (https://… in HTTP mode, file:// in stdio). */
  url: string;
  /** Final payload size in bytes. */
  sizeBytes: number;
  /** Opaque ID for this entry. */
  id: string;
}

export interface ExportPublisher {
  publish(input: PublishInput): Promise<PublishResult> | PublishResult;
}

/**
 * Stdio-mode publisher: writes the file to a per-process temp directory
 * and returns a `file://` URL. Files are not actively cleaned up; the OS
 * temp-dir reaping handles eventual removal.
 */
export class DiskPublisher implements ExportPublisher {
  private readonly dir: string;

  constructor(opts?: { dir?: string }) {
    const base = opts?.dir ?? path.join(os.tmpdir(), "lightfunnels-mcp-exports");
    fs.mkdirSync(base, { recursive: true });
    this.dir = base;
  }

  publish(input: PublishInput): PublishResult {
    const buffer =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : input.content;
    const id = crypto.randomBytes(16).toString("hex");
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const filePath = path.join(this.dir, `${id}_${safeName}`);
    fs.writeFileSync(filePath, buffer);
    return {
      url: pathToFileURL(filePath).toString(),
      sizeBytes: buffer.byteLength,
      id,
    };
  }
}
