import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { ToolHost, ToolInfo } from "./loop.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The server runs one request at a time and answers 503 when busy; nothing ran, so one retry after 2 s is safe. */
export function retryOn503(fetchImpl: Fetch, sleep: (ms: number) => Promise<void> = wait): Fetch {
  return async (input, init) => {
    const res = await fetchImpl(input, init);
    if (res.status !== 503) return res;
    await sleep(2000);
    return fetchImpl(input, init);
  };
}

export const LOGIN_EXPIRED = "Innloggingen er utløpt; start evalueringen på nytt.";

/** OAuth state for one run, in memory only. */
export class MemoryOAuthProvider implements OAuthClientProvider {
  private info: StoredOAuthClientInformation | undefined;
  private saved: StoredOAuthTokens | undefined;
  private verifier = "";
  private done = false;

  constructor(
    private readonly redirect: string,
    private readonly open: (url: URL) => void,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "fiken-mcp eval",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.info = info;
  }
  tokens(): StoredOAuthTokens | undefined {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens): void {
    this.saved = tokens;
  }
  /** The callback server is gone once logged in, so a later authorization (a failed refresh) must stop the run. */
  loggedIn(): void {
    this.done = true;
  }
  redirectToAuthorization(url: URL): void {
    if (this.done) throw new Error(LOGIN_EXPIRED);
    this.open(url);
  }
  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }
  codeVerifier(): string {
    return this.verifier;
  }
}

/** A one-shot local server for the OAuth redirect. */
async function callbackServer(): Promise<{ redirectUrl: string; params: Promise<URLSearchParams>; close(): void }> {
  let resolve!: (p: URLSearchParams) => void;
  const params = new Promise<URLSearchParams>((r) => (resolve = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Innlogget. Du kan lukke denne fanen.");
    resolve(url.searchParams);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { redirectUrl: `http://127.0.0.1:${port}/callback`, params, close: () => server.close() };
}

const openBrowser = (url: URL): void => {
  spawn("open", [url.toString()], { stdio: "ignore", detached: true }).unref();
};

/** Connects to <apiUrl>/mcp, logging in through the browser; the token stays in memory. */
export async function connectHost(apiUrl: string): Promise<ToolHost & { close(): Promise<void> }> {
  const callback = await callbackServer();
  const provider = new MemoryOAuthProvider(callback.redirectUrl, openBrowser);
  const url = new URL("/mcp", apiUrl);
  const newTransport = () => new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: retryOn503(fetch) });
  let client = new Client({ name: "fiken-mcp-eval", version: "0" });
  try {
    const first = newTransport();
    try {
      await client.connect(first);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      console.log("Logg inn med Fiken i nettleseren som åpnet seg …");
      await first.finishAuth(await callback.params);
      client = new Client({ name: "fiken-mcp-eval", version: "0" });
      await client.connect(newTransport());
    }
  } finally {
    callback.close();
  }
  provider.loggedIn();

  const { tools } = await client.listTools();
  return {
    tools: tools.map((t): ToolInfo => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: t.annotations })),
    instructions: client.getInstructions(),
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const content = Array.isArray(r.content) ? (r.content as Array<{ type: string; text?: string }>) : [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      return { text: text || JSON.stringify(r.structuredContent ?? {}), structured: r.structuredContent, isError: r.isError === true };
    },
    close: () => client.close(),
  };
}
