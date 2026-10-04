import { describe, expect, it } from "vitest";
import { HelpError, createHelpClient, filterIndex } from "../../src/help/client.js";

const INDEX = `# Hjelp og kundeservice for Fiken

Hver artikkel finnes også som Markdown ved å legge til \`.md\` på URL-en.
---

- [Hvordan registrere ansattutlegg](https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md)
- [Arbeidsforhold og lønn ](https://hjelp.fiken.no/arbeidsforhold-og-loenn.md)
- [Øreavrunding](https://hjelp.fiken.no/oereavrunding.md)
- [Elsewhere](https://example.com/x.md)
`;

const ARTICLE = `---
title: "Hvordan registrere ansattutlegg"
last_updated: 2026-09-25T09:48:44Z
chatbot_deprioritize: false
source_url:
  canonical: https://hjelp.fiken.no/hvordan-registrere-ansattutlegg
  markdown: https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md
---

# Hvordan registrere ansattutlegg

Kjøpet registreres på vanlig måte.

![Skjermbilde](https://cdn.example/a.png)

Sammen med kjøpet skal det lastes opp en utleggsoppstilling.
`;

function fakeFetch(routes: Record<string, { status?: number; body?: string; url?: string; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    const res = new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
    Object.defineProperty(res, "url", { value: r.url ?? url });
    return res;
  };
  return { impl, calls };
}

describe("help client", () => {
  it("parses the index: only hjelp.fiken.no Markdown links, titles trimmed", async () => {
    const f = fakeFetch({ "https://hjelp.fiken.no/llms.txt": { body: INDEX } });
    const help = createHelpClient({ fetch: f.impl });
    expect(await help.index()).toEqual([
      { slug: "hvordan-registrere-ansattutlegg", title: "Hvordan registrere ansattutlegg" },
      { slug: "arbeidsforhold-og-loenn", title: "Arbeidsforhold og lønn" },
      { slug: "oereavrunding", title: "Øreavrunding" },
    ]);
  });

  it("returns no entries when the index is not the expected Markdown", async () => {
    const f = fakeFetch({ "https://hjelp.fiken.no/llms.txt": { body: "<!doctype html><title>Vedlikehold</title>" } });
    expect(await createHelpClient({ fetch: f.impl }).index()).toEqual([]);
  });

  it("filters by every word of the query, case-insensitively", () => {
    const all = [
      { slug: "a", title: "Hvordan registrere ansattutlegg" },
      { slug: "b", title: "Ansattutlegg med Reiser og utlegg" },
      { slug: "c", title: "Øreavrunding" },
    ];
    expect(filterIndex(all, "ANSATTUTLEGG registrere").map((e) => e.slug)).toEqual(["a"]);
    expect(filterIndex(all, "øre").map((e) => e.slug)).toEqual(["c"]);
    expect(filterIndex(all, undefined)).toEqual(all);
    expect(filterIndex(all, "   ")).toEqual(all);
  });

  it("parses an article: frontmatter, canonical URL, body without image lines", async () => {
    const f = fakeFetch({ "https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md": { body: ARTICLE } });
    const a = await createHelpClient({ fetch: f.impl }).article("hvordan-registrere-ansattutlegg");
    expect(a).toMatchObject({
      slug: "hvordan-registrere-ansattutlegg",
      title: "Hvordan registrere ansattutlegg",
      lastUpdated: "2026-09-25T09:48:44Z",
      url: "https://hjelp.fiken.no/hvordan-registrere-ansattutlegg",
      deprioritized: false,
    });
    expect(a.body).toContain("Sammen med kjøpet");
    expect(a.body).not.toContain("![Skjermbilde]");
    expect(a.body).not.toContain("last_updated");
  });

  it("reads chatbot_deprioritize and keeps an article without frontmatter as body", async () => {
    const f = fakeFetch({
      "https://hjelp.fiken.no/a.md": { body: ARTICLE.replace("chatbot_deprioritize: false", "chatbot_deprioritize: true") },
      "https://hjelp.fiken.no/b.md": { body: "# Bare tekst\n\nInnhold." },
    });
    const help = createHelpClient({ fetch: f.impl });
    expect((await help.article("a")).deprioritized).toBe(true);
    expect(await help.article("b")).toMatchObject({ title: "b", url: "https://hjelp.fiken.no/b", body: "# Bare tekst\n\nInnhold." });
  });

  it.each(["../x", "ansattutlegg.md", "Ansattutlegg", "", "a b"])("refuses the slug %j before any fetch", async (slug) => {
    const f = fakeFetch({});
    await expect(createHelpClient({ fetch: f.impl }).article(slug)).rejects.toBeInstanceOf(HelpError);
    expect(f.calls).toEqual([]);
  });

  it("refuses a redirect to another host, a 404, and an oversized body", async () => {
    const f = fakeFetch({
      "https://hjelp.fiken.no/away.md": { body: ARTICLE, url: "https://example.com/away.md" },
      "https://hjelp.fiken.no/big.md": { body: "x".repeat(20) },
    });
    const help = createHelpClient({ fetch: f.impl, maxBytes: 10 });
    await expect(help.article("away")).rejects.toThrow(/outside hjelp.fiken.no/);
    await expect(help.article("missing")).rejects.toThrow(/fiken_help_index/);
    await expect(help.article("big")).rejects.toThrow(/too large/);
  });

  it("catches body stream errors and throws HelpError", async () => {
    const impl: typeof fetch = async (input) => {
      const url = String(input);
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new DOMException("timeout", "TimeoutError"));
        },
      });
      const res = new Response(stream, { status: 200 });
      Object.defineProperty(res, "url", { value: url });
      return res;
    };
    await expect(createHelpClient({ fetch: impl }).index()).rejects.toBeInstanceOf(HelpError);
    await expect(createHelpClient({ fetch: impl }).index()).rejects.toThrow(/did not answer/);
  });

  it("pre-checks content-length header against maxBytes", async () => {
    const f = fakeFetch({
      "https://hjelp.fiken.no/big.md": { body: "x", headers: { "content-length": "999" } },
    });
    const help = createHelpClient({ fetch: f.impl, maxBytes: 10 });
    await expect(help.article("big")).rejects.toThrow(/too large/);
  });

  it("refuses a redirect when res.redirected is true and url is empty", async () => {
    const impl: typeof fetch = async (input) => {
      const url = String(input);
      const res = new Response(ARTICLE, { status: 200 });
      Object.defineProperty(res, "url", { value: "" });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    };
    await expect(createHelpClient({ fetch: impl }).article("x")).rejects.toThrow(/outside hjelp.fiken.no/);
  });

  it("falls back to default URL when canonical is not a valid https://hjelp.fiken.no URL", async () => {
    const badArticle = ARTICLE.replace("canonical: https://hjelp.fiken.no/hvordan-registrere-ansattutlegg", "canonical: https://example.com/x");
    const f = fakeFetch({
      "https://hjelp.fiken.no/x.md": { body: badArticle },
    });
    const a = await createHelpClient({ fetch: f.impl }).article("x");
    expect(a.url).toBe("https://hjelp.fiken.no/x");
  });

  it("times out", async () => {
    const slow: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
    });
    await expect(createHelpClient({ fetch: slow, timeoutMs: 10 }).index()).rejects.toThrow(/did not answer/);
  });

  it("caches answers for the TTL, and does not cache failures", async () => {
    let now = 0;
    let fail = true;
    const calls: string[] = [];
    const impl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (fail) return new Response("err", { status: 503 });
      return new Response(INDEX);
    };
    const help = createHelpClient({ fetch: impl, now: () => now, ttlMs: 1000 });
    await expect(help.index()).rejects.toBeInstanceOf(HelpError);
    fail = false;
    await help.index();
    await help.index();
    expect(calls).toHaveLength(2);
    now = 1001;
    await help.index();
    expect(calls).toHaveLength(3);
  });
});
