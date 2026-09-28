import { describe, expect, it } from "vitest";
import { clientLabel, isAllowedCimdHost, isAllowedRedirectUri } from "../../src/auth/clients.js";

describe("redirect allowlist", () => {
  it("accepts known clients and loopback", () => {
    for (const u of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc-123",
      "http://localhost:3000/callback",
      "http://127.0.0.1:52341/oauth/callback",
    ]) expect(isAllowedRedirectUri(u), u).toBe(true);
  });

  it("rejects everything else", () => {
    for (const u of [
      "https://evil.example/cb",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback/../x",
      "https://claude.ai/other",
      "http://localhost.evil.example/cb",
      "http://evil.example:3000/cb",
      "not a url",
      "cursor://anysphere.cursor-retrieval/oauth",
    ]) expect(isAllowedRedirectUri(u), u).toBe(false);
  });

  it("labels clients for the consent page", () => {
    expect(clientLabel("https://claude.ai/api/mcp/auth_callback")).toBe("Claude (claude.ai)");
    expect(clientLabel("https://chatgpt.com/connector/oauth/x")).toBe("ChatGPT (chatgpt.com)");
    expect(clientLabel("http://localhost:3000/cb")).toBe("a program on this computer (localhost)");
  });
});

describe("metadata document host allowlist", () => {
  it("accepts the two vendors, with subdomains only under anthropic.com and openai.com", () => {
    for (const h of ["claude.ai", "anthropic.com", "api.anthropic.com", "chatgpt.com", "openai.com", "platform.openai.com"]) {
      expect(isAllowedCimdHost(h), h).toBe(true);
    }
  });

  it("rejects look-alikes, a bare suffix, a port and an empty host", () => {
    for (const h of ["claude.ai.evil.example", "evilanthropic.com", "anthropic.com.evil", ".anthropic.com", "claude.ai:443", "evil.example", ""]) {
      expect(isAllowedCimdHost(h), h).toBe(false);
    }
  });

  it("lowercases the host itself", () => {
    expect(isAllowedCimdHost("CLAUDE.AI")).toBe(true);
  });
});
