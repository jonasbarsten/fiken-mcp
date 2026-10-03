import { describe, expect, it } from "vitest";
import { FikenError } from "../../src/fiken/client.js";
import { counted, noteFikenError, type ToolContext } from "../../src/mcp/context.js";
import { getOperation } from "../../src/mcp/registry.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { callJson, connected, fakeFiken } from "./helpers.js";

describe("read tools", () => {
  it("list_projects pages and trims", async () => {
    const f = fakeFiken([{ match: /\/companies\/demo\/projects\?/, body: [{ projectId: 1, number: "P1", name: "Atlanter", completed: false, contact: { name: "x" } }], headers: { "Fiken-Api-Result-Count": "1" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_projects", { companySlug: "demo", completed: false });
    expect(r.isError).toBe(false);
    expect(r.json()).toEqual({ items: [{ projectId: 1, number: "P1", name: "Atlanter", completed: false }], total: 1, page: 0, pageSize: 25 });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/projects?page=0&pageSize=25&completed=false");
  });

  it("list_accounts passes the range; list_bank_accounts returns account codes", async () => {
    const f = fakeFiken([
      { match: /\/accounts\?/, body: [{ code: "6300", name: "Leie lokale" }] },
      { match: /\/bankAccounts$/, body: [{ bankAccountId: 9, name: "Drift", accountCode: "1920:10001", bankAccountNumber: "12345678903", type: "normal", inactive: false, iban: "x" }] },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_accounts", { companySlug: "demo", range: "4000-7999" })).json()).toMatchObject({ items: [{ code: "6300", name: "Leie lokale" }] });
    expect(f.calls[0]?.url).toContain("range=4000-7999");
    expect((await callJson(c, "list_bank_accounts", { companySlug: "demo" })).json()).toEqual({ items: [{ bankAccountId: 9, name: "Drift", accountCode: "1920:10001", bankAccountNumber: "12345678903", type: "normal", inactive: false }] });
  });

  it("search_contacts and get_contact", async () => {
    const f = fakeFiken([
      { match: /\/contacts\?/, body: [{ contactId: 5, name: "Clas Ohlson AS", supplier: true, customer: false, supplierNumber: 20001, notes: [{ x: 1 }] }], headers: { "Fiken-Api-Result-Count": "1" } },
      { match: /\/contacts\/5$/, body: { contactId: 5, name: "Clas Ohlson AS", supplier: true, customer: false, notes: [], documents: [], address: { country: "Norway" } } },
    ]);
    const c = await connected(f.fetchImpl);
    const s = (await callJson(c, "search_contacts", { companySlug: "demo", name: "Clas Ohlson AS", supplier: true })).json() as { items: unknown[] };
    expect(s.items).toEqual([{ contactId: 5, name: "Clas Ohlson AS", supplier: true, customer: false, supplierNumber: 20001 }]);
    expect(f.calls[0]?.url).toContain("name=Clas+Ohlson+AS&supplier=true");
    const g = (await callJson(c, "get_contact", { companySlug: "demo", contactId: 5 })).json() as Record<string, unknown>;
    expect(g).not.toHaveProperty("notes");
    expect(g).toMatchObject({ contactId: 5, address: { country: "Norway" } });
  });

  it("list_purchases, get_purchase and list_inbox trim to what the model needs", async () => {
    const purchase = {
      purchaseId: 77, date: "2026-09-01", kind: "cash_purchase", paid: true, currency: "NOK", identifier: "R-1",
      supplier: { contactId: 5, name: "Clas Ohlson AS", notes: [] },
      project: [{ projectId: 1, name: "Atlanter", contact: {} }],
      lines: [{ lineId: 3, description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }],
      purchaseAttachments: [{ uuid: "u", filename: "r.pdf", downloadUrl: "https://x" }],
      payments: [{ amount: 12500 }],
    };
    const f = fakeFiken([
      { match: /\/purchases\?/, body: [purchase], headers: { "Fiken-Api-Result-Count": "1" } },
      { match: /\/purchases\/77$/, body: purchase },
      { match: /\/inbox\?/, body: [{ documentId: 1234134, name: "r.pdf", filename: "r.pdf", status: false, createdAt: "2026-09-01T10:00:00Z", documentUrl: "https://x" }], headers: { "Fiken-Api-Result-Count": "1" } },
    ]);
    const c = await connected(f.fetchImpl);
    const l = (await callJson(c, "list_purchases", { companySlug: "demo", dateGe: "2026-09-01" })).json() as { items: Array<Record<string, unknown>> };
    expect(l.items[0]).toEqual({
      purchaseId: 77, date: "2026-09-01", dueDate: undefined, kind: "cash_purchase", paid: true, identifier: "R-1", currency: "NOK",
      supplier: { contactId: 5, name: "Clas Ohlson AS" }, project: [{ projectId: 1, name: "Atlanter" }],
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }], attachments: 1,
    });
    expect(f.calls[0]?.url).toContain("dateGe=2026-09-01");
    const g = (await callJson(c, "get_purchase", { companySlug: "demo", purchaseId: 77 })).json() as Record<string, unknown>;
    expect(g.purchaseAttachments).toEqual([{ uuid: "u", filename: "r.pdf" }]);
    const i = (await callJson(c, "list_inbox", { companySlug: "demo" })).json() as { items: unknown[] };
    expect(i.items).toEqual([{ documentId: 1234134, name: "r.pdf", filename: "r.pdf", status: false, createdAt: "2026-09-01T10:00:00Z" }]);
    expect(f.calls[2]?.url).toContain("status=unused");
    expect(f.calls[2]?.url).toContain("sortBy=createdDate+desc");
  });

  it("a Fiken 401 on a read-only call sets session.fikenUnauthorized when /user also answers 401", async () => {
    const f = fakeFiken([
      { match: /\/projects\?/, status: 401, body: { message: "expired" } },
      { match: /\/user$/, status: 401, body: { message: "expired" } },
    ]);
    const session = { fikenUnauthorized: false, wrote: false };
    const c = await connected(f.fetchImpl, { session });
    const r = await callJson(c, "list_projects", { companySlug: "demo" });
    expect(r.isError).toBe(true);
    expect(session.fikenUnauthorized).toBe(true);
  });

  it("a Fiken 401 on one endpoint while /user answers 200 is a tool error, not a dead session", async () => {
    const f = fakeFiken([
      { match: /\/invoices\/counter$/, status: 401, body: { message: "no access to counter" } },
      { match: /\/user$/, body: { name: "Jonas", email: "j@example.com" } },
    ]);
    const session = { fikenUnauthorized: false, wrote: false };
    const c = await connected(f.fetchImpl, { session });
    const r = await callJson(c, "get_counters", { companySlug: "demo" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Fiken refused this request (401) although the login is valid: {"message":"no access to counter"}. The company may lack the module or permission this needs.',
    );
    expect(session.fikenUnauthorized).toBe(false);
  });

  it("several Fiken 401s in one request cost at most one /user check", async () => {
    const f = fakeFiken([
      { match: /\/counter$/, status: 401, body: "no" },
      { match: /\/projects\?/, status: 401, body: "no" },
      { match: /\/user$/, body: { name: "Jonas", email: "j@example.com" } },
    ]);
    const session = { fikenUnauthorized: false, wrote: false };
    const c = await connected(f.fetchImpl, { session });
    expect((await callJson(c, "get_counters", { companySlug: "demo" })).text).toContain("although the login is valid");
    expect((await callJson(c, "list_projects", { companySlug: "demo" })).text).toContain("although the login is valid");
    expect(f.calls.filter((x) => x.url.endsWith("/user"))).toHaveLength(1);
    expect(session.fikenUnauthorized).toBe(false);
  });

  it("a failing /user check (not a 401) leaves the session alive", async () => {
    const f = fakeFiken([
      { match: /\/projects\?/, status: 401, body: "no" },
      { match: /\/user$/, status: 503, body: "down" },
    ]);
    const session = { fikenUnauthorized: false, wrote: false };
    const c = await connected(f.fetchImpl, { session });
    expect((await callJson(c, "list_projects", { companySlug: "demo" })).isError).toBe(true);
    expect(session.fikenUnauthorized).toBe(false);
  });

  it("an unknown company slug lists the known slugs in the error", async () => {
    const f = fakeFiken([
      { match: /\/companies\/nope\/projects/, status: 404, body: { message: "not found" } },
      { match: /\/companies$/, body: [{ name: "Demo", slug: "demo" }, { name: "Other", slug: "other-as" }] },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_projects", { companySlug: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Known company slugs: demo, other-as");
  });

  it("a 404 for a company the user has is an id problem, not a missing company", async () => {
    const f = fakeFiken([
      { match: /\/invoices\/999$/, status: 404, body: { message: "not found" } },
      { match: /\/companies$/, body: [{ name: "Demo", slug: "demo" }] },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "get_invoice", { companySlug: "demo", invoiceId: 999 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("check the id you passed");
    expect(r.text).not.toContain("was not found");
  });

  it("carries the øre note where amounts appear", () => {
    expect(getOperation("list_purchases")?.description).toContain("øre");
  });
});

describe("write tools", () => {
  it("create_contact posts the supplier and returns its id", async () => {
    const f = fakeFiken([{ match: /\/contacts$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/contacts/5" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_contact", { companySlug: "demo", name: "Clas Ohlson AS", organizationNumber: "913312465" });
    expect(r.json()).toEqual({ contactId: 5 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ name: "Clas Ohlson AS", organizationNumber: "913312465", supplier: true, customer: false });
  });

  it("create_purchase books, attaches the inbox document and returns the purchase", async () => {
    const f = fakeFiken([
      { match: /\/purchases$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77" } },
      { match: /\/purchases\/77\/attachments\?inboxDocumentId=1234134&attachToSale=true&attachToPayment=true$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77/attachments/u" } },
      { match: /\/purchases\/77$/, body: { purchaseId: 77, date: "2026-09-01", kind: "cash_purchase", paid: true, currency: "NOK", lines: [], purchaseAttachments: [{ uuid: "u", filename: "r.pdf" }] } },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase", {
      companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-09-01", projectId: 1,
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }], inboxDocumentId: 1234134,
    });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ purchaseId: 77, attachedInboxDocumentId: 1234134, purchaseAttachments: [{ uuid: "u", filename: "r.pdf" }] });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
      date: "2026-09-01", kind: "cash_purchase", currency: "NOK", paymentAccount: "1920:10001", paymentDate: "2026-09-01", projectId: 1,
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }],
    });
    expect(f.calls[1]?.init?.method).toBe("POST");
    expect(f.calls.map((x) => x.url.replace("https://api.test/v2", ""))).toEqual([
      "/companies/demo/purchases",
      // Fiken rejects an attachment with neither flag; a cash receipt documents both the purchase and its payment.
      "/companies/demo/purchases/77/attachments?inboxDocumentId=1234134&attachToSale=true&attachToPayment=true",
      "/companies/demo/purchases/77",
    ]);
  });

  it("create_purchase attaches a supplier purchase's receipt to the sale only", async () => {
    const f = fakeFiken([
      { match: /\/purchases$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/78" } },
      { match: /\/purchases\/78\/attachments\?inboxDocumentId=99&attachToSale=true$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/78/attachments/u" } },
      { match: /\/purchases\/78$/, body: { purchaseId: 78, date: "2026-09-01", kind: "supplier", paid: false, currency: "NOK", lines: [], purchaseAttachments: [{ uuid: "u", filename: "r.pdf" }] } },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase", {
      companySlug: "demo", date: "2026-09-01", kind: "supplier", supplierId: 5, dueDate: "2026-09-30",
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }], inboxDocumentId: 99,
    });
    expect(r.isError).toBe(false);
    expect(f.calls[1]?.url.replace("https://api.test/v2", "")).toBe("/companies/demo/purchases/78/attachments?inboxDocumentId=99&attachToSale=true");
  });

  it("create_purchase names the created purchase when attaching the receipt fails, so the model doesn't book it twice", async () => {
    const f = fakeFiken([
      { match: /\/purchases$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77" } },
      { match: /\/purchases\/77\/attachments\?inboxDocumentId=1234134/, status: 500, body: "boom" },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase", {
      companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-09-01",
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }], inboxDocumentId: 1234134,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Purchase 77 was created");
    expect(r.text).toContain("inboxDocumentId 1234134");
    expect(r.text).toContain(
      'call fiken_write with {"operation":"attach_inbox_document","args":{"companySlug":"demo","purchaseId":77,"inboxDocumentId":1234134}}',
    );
    expect(f.calls.filter((x) => x.url.endsWith("/purchases"))).toHaveLength(1);
  });

  it("create_purchase does not ask for a second attachment when only the read-back failed", async () => {
    const f = fakeFiken([
      { match: /\/purchases$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77" } },
      { match: /\/purchases\/77\/attachments\?inboxDocumentId=1234134&attachToSale=true&attachToPayment=true$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77/attachments/u" } },
      { match: /\/purchases\/77$/, status: 500, body: "boom" },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase", {
      companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-09-01",
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }], inboxDocumentId: 1234134,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Purchase 77 was created");
    expect(r.text).toContain('call fiken_read with {"operation":"get_purchase","args":{"companySlug":"demo","purchaseId":77}}');
    expect(r.text).not.toContain("attach_inbox_document");
  });

  it("create_purchase as a real tool refuses a mistyped top-level key before any Fiken call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await c.callTool({ name: "create_purchase", arguments: {
      companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-09-01",
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }], projectID: 3,
    } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]?.text).toContain("projectID");
    expect(f.calls).toHaveLength(0);
  });

  it("create_purchase leaves session.fikenUnauthorized false when the write succeeded but the attach got a Fiken 401", async () => {
    const f = fakeFiken([
      { match: /\/purchases$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77" } },
      { match: /\/purchases\/77\/attachments\?inboxDocumentId=1234134/, status: 401, body: "expired" },
    ]);
    const session = { fikenUnauthorized: false, wrote: false };
    const c = await connected(f.fetchImpl, { session });
    const r = await callJson(c, "create_purchase", {
      companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-09-01",
      lines: [{ description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }], inboxDocumentId: 1234134,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Purchase 77 was created");
    expect(session.fikenUnauthorized).toBe(false);
    expect(f.calls.some((x) => x.url.endsWith("/user"))).toBe(false);
  });

  it("create_purchase refuses a mistyped key in a line before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase", { companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", lines: [{ description: "x", netPrice: 1, vat: 0, account: "6540", vatType: "NONE", vatTyp: "HIGH" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("vatTyp");
    expect(f.calls).toHaveLength(0);
  });

  it("create_purchase without an inbox document makes no attachment call and relays Fiken's validation error", async () => {
    const f = fakeFiken([{ match: /\/purchases$/, status: 400, body: { message: "paymentAccount is required for cash purchases" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase", { companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", lines: [{ description: "x", netPrice: 1, vat: 0, account: "6540", vatType: "NONE" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("paymentAccount is required");
    expect(f.calls).toHaveLength(1);
  });
});

describe("write guard", () => {
  /** A Fiken client whose /user check answers `status` and counts how often it was asked. */
  const loginCheck = (status: number) => {
    const asked = { count: 0 };
    const fiken = {
      json: async (path: string) => {
        asked.count++;
        if (path !== "/user") throw new Error(`unexpected ${path}`);
        if (status !== 200) throw new FikenError(status, "expired");
        return { name: "Jonas", email: "j@example.com" };
      },
    };
    return { fiken, asked };
  };

  it("a Fiken 401 after a write in the same request is not flagged for an HTTP 401 and makes no login check", async () => {
    const written = loginCheck(401);
    const ctx = { fiken: written.fiken, session: { fikenUnauthorized: false, wrote: true } } as unknown as ToolContext;
    await noteFikenError(ctx, new FikenError(401, "expired"));
    expect(ctx.session.fikenUnauthorized).toBe(false);
    expect(written.asked.count).toBe(0);
    const fresh = { fiken: loginCheck(401).fiken, session: { fikenUnauthorized: false, wrote: false } } as unknown as ToolContext;
    await noteFikenError(fresh, new FikenError(401, "expired"));
    expect(fresh.session.fikenUnauthorized).toBe(true);
  });

  it("counted() does not flag a Fiken 401 thrown out of a handler that already wrote", async () => {
    const written = loginCheck(401);
    const ctx = { fiken: written.fiken, anonId: "anon", usage: memoryUsageStore(), session: { fikenUnauthorized: false, wrote: false } } as unknown as ToolContext;
    const handler = counted(ctx, "probe", async () => {
      ctx.session.wrote = true;
      throw new FikenError(401, "x");
    });
    const result = await handler({}, undefined);
    expect(result.isError).toBe(true);
    expect(ctx.session.fikenUnauthorized).toBe(false);
    expect(written.asked.count).toBe(0);
    const readOnly = { fiken: loginCheck(401).fiken, anonId: "anon", usage: memoryUsageStore(), session: { fikenUnauthorized: false, wrote: false } } as unknown as ToolContext;
    await counted(readOnly, "probe", async () => {
      throw new FikenError(401, "x");
    })({}, undefined);
    expect(readOnly.session.fikenUnauthorized).toBe(true);
  });

  it("connected() marks the session as written after a successful POST", async () => {
    const session = { fikenUnauthorized: false, wrote: false };
    const f = fakeFiken([{ match: /\/contacts$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/contacts/5" } }]);
    const c = await connected(f.fetchImpl, { session });
    expect((await callJson(c, "create_contact", { companySlug: "demo", name: "Ny kunde AS", customer: true })).isError).toBe(false);
    expect(session.wrote).toBe(true);
  });
});
