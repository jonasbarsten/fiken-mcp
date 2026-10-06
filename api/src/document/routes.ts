import { Hono } from "hono";
import type { Config } from "../config.js";
import { BlobError } from "../crypto/blob.js";
import { createFikenClient, FikenError } from "../fiken/client.js";
import { detectType } from "../upload/detect.js";
import { widgetCors } from "../upload/routes.js";
import { readViewTicket } from "./ticket.js";

// A binary Lambda response goes out base64-encoded under a 6 MB payload limit,
// which is 4.5 MB of raw bytes: keep a margin, as the upload route does.
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The document viewer widget fetches the file here. No cookies, no session:
 * the view ticket (from show_document) carries the Fiken token and the one file
 * URL it may fetch for the next five minutes. The file passes through memory
 * only. Every refusal is a bare status, so nothing about the ticket or Fiken's
 * answer leaks to whoever holds the URL.
 */
export function documentRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.use("/document", widgetCors(["GET", "OPTIONS"], ["x-ticket"]));

  app.get("/document", async (c) => {
    // Header only, as for /upload: a ticket in the query string would be copied
    // into access logs and history wherever the URL travels. Nothing else from
    // the request is read: the file URL comes from the sealed ticket alone.
    let ticket;
    try {
      ticket = readViewTicket(cfg, c.req.header("x-ticket") ?? "");
    } catch (err) {
      if (err instanceof BlobError) return c.body(null, 401);
      throw err;
    }

    const fiken = createFikenClient({ baseUrl: cfg.fikenBaseUrl, fileBaseUrl: cfg.fikenFileBaseUrl, accessToken: ticket.fikenAccessToken, fetch: cfg.fetch });
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      // download() refuses any URL outside Fiken before sending the token.
      ({ bytes } = await fiken.download(ticket.fileUrl));
    } catch (err) {
      if (!(err instanceof FikenError)) throw err;
      // A token Fiken refuses makes the ticket worthless: answer like an expired one.
      if (err.status === 401 || err.status === 404 || err.status === 413) return c.body(null, err.status);
      return c.body(null, 502);
    }
    if (bytes.length > MAX_BYTES) return c.body(null, 413);

    // Typed by magic bytes only, never by what Fiken declared.
    const detected = detectType(bytes);
    if (!detected) return c.body(null, 415);
    return c.body(bytes, 200, { "content-type": detected.mime, "cache-control": "no-store" });
  });

  return app;
}
