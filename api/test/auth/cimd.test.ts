import { beforeEach, describe, expect, it } from "vitest";
import { clearCimdCache, fetchClientMetadata, isCimdClientId, resolveClient } from "../../src/auth/cimd.js";
import { testConfig } from "../../src/config.js";

const DOC_URL = "https://claude.ai/.well-known/mcp-client.json";
const doc = { client_id: DOC_URL, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
function cfgServing(body: unknown, status = 200) {
  const calls: string[] = [];
  const cfg = testConfig({ fetch: async (input) => { calls.push(String(input)); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); } });
  return { cfg, calls };
}

describe("cimd", () => {
  beforeEach(() => clearCimdCache());

  it("recognises only https urls on allowlisted hosts with a path", () => {
    expect(isCimdClientId(DOC_URL)).toBe(true);
    expect(isCimdClientId("https://platform.openai.com/mcp/client.json")).toBe(true);
    expect(isCimdClientId("http://claude.ai/x.json")).toBe(false);
    expect(isCimdClientId("https://claude.ai")).toBe(false);
    expect(isCimdClientId("https://claude.ai/x.json?y=1")).toBe(false);
    expect(isCimdClientId("https://evil.example/x.json")).toBe(false);
    expect(isCimdClientId("https://claude.ai.evil.example/x.json")).toBe(false);
    expect(isCimdClientId("https://u:p@claude.ai/x.json")).toBe(false);
    expect(isCimdClientId("v1.k1.abc.def")).toBe(false);
  });

  it("fetches, validates and caches the document", async () => {
    const { cfg, calls } = cfgServing(doc);
    expect(await fetchClientMetadata(cfg, DOC_URL, 1000)).toEqual({ redirectUris: doc.redirect_uris, name: "Claude" });
    expect(await fetchClientMetadata(cfg, DOC_URL, 1000 + 3599)).toEqual({ redirectUris: doc.redirect_uris, name: "Claude" });
    expect(calls).toHaveLength(1);
    await fetchClientMetadata(cfg, DOC_URL, 1000 + 3601);
    expect(calls).toHaveLength(2);
  });

  it("rejects a mismatched client_id, missing redirect_uris, non-json, non-200 and oversized documents, and never fetches a non-allowlisted url", async () => {
    await expect(fetchClientMetadata(cfgServing({ ...doc, client_id: "https://claude.ai/other.json" }).cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing({ client_id: DOC_URL }).cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing("<html>").cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing(doc, 404).cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing({ ...doc, pad: "x".repeat(20_000) }).cfg, DOC_URL)).rejects.toThrow();
    // The cap counts bytes: 9,000 two-byte characters are 18,000 bytes but only 9,000 UTF-16 units.
    await expect(fetchClientMetadata(cfgServing({ ...doc, pad: "æ".repeat(9_000) }).cfg, DOC_URL)).rejects.toThrow("too large");
    const { cfg, calls } = cfgServing(doc);
    await expect(fetchClientMetadata(cfg, "https://evil.example/x.json")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("resolveClient falls back to signed client ids", async () => {
    const { cfg } = cfgServing(doc);
    await expect(resolveClient(cfg, "garbage")).rejects.toThrow();
    expect(await resolveClient(cfg, DOC_URL)).toEqual({ redirectUris: doc.redirect_uris, name: "Claude" });
  });
});
