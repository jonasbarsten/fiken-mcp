import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { BlobError } from "../crypto/blob.js";
import { createFikenClient, FikenError } from "../fiken/client.js";
import { detectType, safeFilename } from "./detect.js";
import { readUploadTicket } from "./ticket.js";

// Lambda's request payload ceiling is 6 MiB base64-encoded, which is 4.5 MiB of
// raw bytes: exactly on that edge, so leave a margin.
const MAX_BYTES = 4 * 1024 * 1024;
/**
 * Where Claude (<id>.claudemcpcontent.com) and ChatGPT (<id>.web-sandbox.oaiusercontent.com) serve MCP App widgets;
 * the only origins allowed to call the widget routes cross-origin. ChatGPT's labels can carry underscores
 * (asdk_app_<hex>, seen from the iOS app 2026-10-06), and ChatGPT Desktop uses its own scheme, codex-sandbox://
 * (seen 2026-10-06), for the same sandbox domain.
 */
export const WIDGET_ORIGIN =
  /^(?:https:\/\/[a-z0-9-]+\.claudemcpcontent\.com|(?:https|codex-sandbox):\/\/(?:[a-z0-9_-]+\.)+web-sandbox\.oaiusercontent\.com)$/;

/**
 * CORS for a widget route, logging every preflight's origin, requested headers and whether it was allowed. A refused
 * preflight leaves no other trace (the browser then never sends the request), and hosts render widgets from origins
 * they do not document. An origin is a domain, not user data.
 */
export function widgetCors(allowMethods: string[], allowHeaders: string[]): MiddlewareHandler {
  const handler = cors({ origin: (origin) => (WIDGET_ORIGIN.test(origin) ? origin : ""), allowMethods, allowHeaders, maxAge: 600 });
  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      const origin = (c.req.header("origin") ?? "").slice(0, 200);
      log("widget_preflight", {
        route: c.req.path,
        origin,
        allowed: WIDGET_ORIGIN.test(origin),
        requestedHeaders: (c.req.header("access-control-request-headers") ?? "").slice(0, 200),
      });
    }
    return handler(c, next);
  };
}

/**
 * The widget percent-encodes the name, because a header value may not carry the
 * non-ASCII characters a Norwegian filename often has. A hand-written curl call
 * sends it raw, and a raw name may contain a stray `%`, so a decode failure
 * falls back to the value as sent rather than rejecting the upload.
 */
function decodeFilename(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    if (err instanceof URIError) return value;
    throw err;
  }
}

/**
 * The public receipt upload endpoint the MCP App widget posts to. No cookies,
 * no session: the ticket (issued alongside the widget resource) carries the
 * Fiken token and target company for the next 15 minutes.
 */
export function uploadRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.use("/upload", widgetCors(["POST", "OPTIONS"], ["content-type", "x-filename", "x-ticket"]));

  app.post("/upload", async (c) => {
    // Header only: a ticket in the query string would be copied into access
    // logs, shell history and browser history wherever the URL travels.
    const ticketValue = c.req.header("x-ticket") ?? "";
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

    const filename = safeFilename(decodeFilename(c.req.header("x-filename") ?? ""), detected.ext);

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
      // Fiken refusing the sealed token means the ticket is worthless, whatever
      // its own expiry says. Answer like an expired ticket so the widget tells
      // the user to reopen the upload instead of reporting a server fault.
      if (err instanceof FikenError && err.status === 401) return c.json({ error: "invalid_ticket" }, 401);
      if (err instanceof FikenError) return c.json({ error: "fiken", status: err.status, message: err.body.slice(0, 200) }, 502);
      throw err;
    }
  });

  app.get("/upload", (c) => c.body(null, 405));

  return app;
}
