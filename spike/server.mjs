// Throwaway spike: does an MCP App widget with a file picker work inside the
// Claude iOS app (and ChatGPT), and can it POST the bytes to our own domain?
//
// Nothing here is production code. No auth, no Fiken, in-memory only.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { Tunnel } from "cloudflared";

const PORT = Number(process.env.PORT ?? 3000);
const BUNDLE_PATH = new URL(
  "./node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
  import.meta.url,
);
const PDFJS_PATH = new URL(
  "./node_modules/pdfjs-dist/build/pdf.min.mjs",
  import.meta.url,
);
const PDFJS_WORKER_PATH = new URL(
  "./node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
);
const WIDGET_PATH = new URL("./widget.html", import.meta.url);

let publicUrl = process.env.PUBLIC_URL ?? "";
const uploads = [];

const log = (...args) => console.log(new Date().toISOString(), ...args);

// The widget runs in a sandboxed iframe that may not be allowed to load
// scripts from our domain, so every ES module it needs is inlined. Each
// bundle ends in a single `export{...}` statement, which we rewrite into a
// global so the widget code can pick it up.
async function inlineEsm(path, globalName) {
  const bundle = await readFile(path, "utf8");
  const exportStart = bundle.lastIndexOf("export{");
  const exportEnd = bundle.lastIndexOf("}");
  const head = bundle.slice(0, exportStart);
  const exportList = bundle.slice(exportStart + "export{".length, exportEnd);
  const mapped = exportList
    .split(",")
    .map((entry) => {
      const [local, exported] = entry.trim().split(/\s+as\s+/);
      return `${exported ?? local}:${local}`;
    })
    .join(",");
  return `${head}globalThis.${globalName}={${mapped}};`.replaceAll(
    "</script",
    "<\\/script",
  );
}

async function buildWidgetHtml() {
  const [appsBundle, pdfWorker, pdfMain, template] = await Promise.all([
    inlineEsm(BUNDLE_PATH, "__mcpApps"),
    inlineEsm(PDFJS_WORKER_PATH, "__pdfjsWorker"),
    inlineEsm(PDFJS_PATH, "__pdfjs"),
    readFile(WIDGET_PATH, "utf8"),
  ]);
  const version = createHash("sha256").update(template).digest("hex").slice(0, 8);
  return template
    .replace("/*__PDFJS_WORKER__*/", () => pdfWorker)
    .replace("/*__PDFJS__*/", () => pdfMain)
    .replace("/*__BUNDLE__*/", () => appsBundle)
    .replaceAll("__PUBLIC_URL__", publicUrl)
    .replaceAll("__WIDGET_VERSION__", version);
}

// The tool always points at one stable resource URI. Claude caches the tool
// list per connector, so a URI that changes per build leaves stale caches
// pointing at resources we no longer serve, which Claude reports as
// "Unable to reach". The widget's own version stamp shows which build ran.
const RESOURCE_URI = "ui://fiken-spike/upload.html";

async function widgetContents(uri) {
  return {
    contents: [
      {
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await buildWidgetHtml(),
        _meta: { ui: { csp: { connectDomains: [publicUrl] } } },
      },
    ],
  };
}

async function createMcpServer() {
  const mcp = new McpServer({ name: "fiken-upload-spike", version: "0.0.1" });

  registerAppTool(
    mcp,
    "upload_receipts",
    {
      title: "Upload receipts",
      description:
        "Shows a picker where the user selects receipt photos or PDFs from their device. " +
        "Call this when the user wants to upload receipts. When the user says they are done, " +
        "call list_uploads to see what arrived on the server.",
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (ctx) => {
      const ticket = randomUUID();
      log("tool upload_receipts called, ticket", ticket, "resource", RESOURCE_URI);
      // Cache-invalidation experiment: tell the host our tool and resource
      // lists changed. ctx.mcpReq.notify binds the notification to this
      // request, so on the stateless transport it rides this call's stream.
      await ctx.mcpReq.notify({ method: "notifications/tools/list_changed" });
      await ctx.mcpReq.notify({ method: "notifications/resources/list_changed" });
      log("sent tools/list_changed and resources/list_changed on the request stream");
      return {
        content: [
          {
            type: "text",
            text: "Upload widget opened. Ask the user to pick their receipts, then call list_uploads.",
          },
        ],
        structuredContent: { uploadUrl: `${publicUrl}/upload`, ticket },
      };
    },
  );

  mcp.registerTool(
    "list_uploads",
    {
      title: "List uploads",
      description: "Lists the files the upload widget has sent to the server so far.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: uploads.length
            ? JSON.stringify(uploads, null, 2)
            : "No uploads received yet.",
        },
      ],
    }),
  );

  registerAppResource(
    mcp,
    "Receipt upload widget",
    RESOURCE_URI,
    { description: "File picker that posts files to the spike server" },
    async () => widgetContents(RESOURCE_URI),
  );

  return mcp;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-filename,x-ticket");
  res.setHeader("Access-Control-Max-Age", "600");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  log(
    req.method,
    url.pathname,
    "origin=" + (req.headers.origin ?? "-"),
    "ua=" + String(req.headers["user-agent"] ?? "-").slice(0, 70),
  );
  try {
    if (url.pathname === "/mcp") {
      // Read the body ourselves so we can log the JSON-RPC method, then hand
      // the parsed body to the transport.
      let parsedBody;
      if (req.method === "POST") {
        const raw = (await readBody(req)).toString("utf8");
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          parsedBody = undefined;
        }
        const msgs = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
        for (const m of msgs) {
          if (!m) continue;
          const detail = m.params?.uri ?? m.params?.name ?? "";
          log("  rpc", m.method ?? "(response)", detail);
        }
      }
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcp = await createMcpServer();
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === "OPTIONS") {
      cors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/upload" && req.method === "POST") {
      cors(req, res);
      const body = await readBody(req);
      const entry = {
        id: uploads.length + 1,
        name: decodeURIComponent(String(req.headers["x-filename"] ?? "unknown")),
        type: String(req.headers["content-type"] ?? ""),
        size: body.length,
        sha256: createHash("sha256").update(body).digest("hex").slice(0, 16),
        ticket: req.headers["x-ticket"] ?? null,
        origin: req.headers.origin ?? null,
        receivedAt: new Date().toISOString(),
      };
      uploads.push(entry);
      log("UPLOAD", entry);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(entry));
      return;
    }

    if (url.pathname === "/uploads") {
      cors(req, res);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(uploads, null, 2));
      return;
    }

    if (url.pathname === "/widget") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await buildWidgetHtml());
      return;
    }

    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      `fiken upload spike\nMCP endpoint: ${publicUrl}/mcp\nuploads received: ${uploads.length}\n`,
    );
  } catch (err) {
    log("ERROR", err);
    if (!res.headersSent) res.writeHead(500);
    res.end("error");
  }
});

async function start() {
  await new Promise((resolve) => httpServer.listen(PORT, "127.0.0.1", resolve));
  log(`listening on http://127.0.0.1:${PORT}`);

  if (!publicUrl) {
    log("starting cloudflared quick tunnel...");
    const tunnel = Tunnel.quick(`http://127.0.0.1:${PORT}`);
    tunnel.on("exit", (code) => {
      log("tunnel exited with code", code);
      process.exit(1);
    });
    publicUrl = await new Promise((resolve) => tunnel.once("url", resolve));
    await new Promise((resolve) => tunnel.once("connected", resolve));
  }

  log("");
  log(`PUBLIC URL:        ${publicUrl}`);
  log(`Connector URL:     ${publicUrl}/mcp`);
  log(`Widget preview:    ${publicUrl}/widget`);
  log(`Uploads so far:    ${publicUrl}/uploads`);
  log("");
}

start().catch((err) => {
  log("fatal", err);
  process.exit(1);
});
