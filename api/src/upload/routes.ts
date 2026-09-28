import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "../config.js";
import { BlobError } from "../crypto/blob.js";
import { createFikenClient, FikenError } from "../fiken/client.js";
import { detectType, safeFilename } from "./detect.js";
import { readUploadTicket } from "./ticket.js";

const MAX_BYTES = 4.5 * 1024 * 1024;
const WIDGET_ORIGIN = /^https:\/\/[a-z0-9-]+\.claudemcpcontent\.com$/;

/**
 * The public receipt upload endpoint the MCP App widget posts to. No cookies,
 * no session: the ticket (issued alongside the widget resource) carries the
 * Fiken token and target company for the next 15 minutes.
 */
export function uploadRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.use(
    "/upload",
    cors({
      origin: (origin) => (WIDGET_ORIGIN.test(origin) ? origin : ""),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["content-type", "x-filename", "x-ticket"],
      maxAge: 600,
    }),
  );

  app.post("/upload", async (c) => {
    const ticketValue = c.req.header("x-ticket") ?? c.req.query("ticket") ?? "";
    let ticket;
    try {
      ticket = readUploadTicket(cfg, ticketValue);
    } catch (err) {
      if (err instanceof BlobError) return c.json({ error: "invalid_ticket" }, 401);
      throw err;
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) return c.json({ error: "empty" }, 400);
    if (bytes.length > MAX_BYTES) return c.json({ error: "too_large", limitBytes: MAX_BYTES }, 413);

    const detected = detectType(bytes);
    if (!detected) return c.json({ error: "unsupported_type" }, 415);

    const filename = safeFilename(c.req.header("x-filename") ?? "", detected.ext);

    const form = new FormData();
    form.append("name", filename);
    form.append("filename", filename);
    form.append("description", "Uploaded via Fiken MCP");
    form.append("file", new Blob([bytes], { type: detected.mime }), filename);

    const fiken = createFikenClient({ baseUrl: cfg.fikenBaseUrl, accessToken: ticket.fikenAccessToken, fetch: cfg.fetch });

    try {
      const result = await fiken.upload(`/companies/${ticket.companySlug}/inbox`, form);
      // Inbox documents always carry a numeric id; a Location without one means Fiken answered unexpectedly.
      if (result.id === undefined) return c.json({ error: "fiken", status: 502, message: "missing document id" }, 502);
      return c.json({ documentId: result.id, name: filename, size: bytes.length, type: detected.mime }, 201);
    } catch (err) {
      if (err instanceof FikenError) return c.json({ error: "fiken", status: err.status, message: err.body.slice(0, 200) }, 502);
      throw err;
    }
  });

  app.get("/upload", (c) => c.body(null, 405));

  return app;
}
