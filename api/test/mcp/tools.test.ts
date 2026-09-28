import { describe, expect, it } from "vitest";
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
      { match: /\/bankAccounts$/, body: [{ bankAccountId: 9, name: "Drift", accountCode: "1920:10001", type: "normal", inactive: false, iban: "x" }] },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_accounts", { companySlug: "demo", range: "4000-7999" })).json()).toMatchObject({ items: [{ code: "6300", name: "Leie lokale" }] });
    expect(f.calls[0]?.url).toContain("range=4000-7999");
    expect((await callJson(c, "list_bank_accounts", { companySlug: "demo" })).json()).toEqual({ items: [{ bankAccountId: 9, name: "Drift", accountCode: "1920:10001", type: "normal", inactive: false }] });
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

  it("every tool carries annotations and the øre note where amounts appear", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tools = (await c.listTools()).tools;
    for (const name of ["list_projects", "list_accounts", "list_bank_accounts", "search_contacts", "get_contact", "list_purchases", "get_purchase", "list_inbox"]) {
      const t = tools.find((x) => x.name === name);
      expect(t?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(tools.find((x) => x.name === "list_purchases")?.description).toContain("øre");
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
    expect(r.text).toContain("attach_inbox_document");
    expect(r.text).toContain("purchaseId 77");
    expect(r.text).toContain("inboxDocumentId 1234134");
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
    expect(r.text).toContain("get_purchase with purchaseId 77");
    expect(r.text).not.toContain("attach_inbox_document");
  });

  it("create_purchase without an inbox document makes no attachment call and relays Fiken's validation error", async () => {
    const f = fakeFiken([{ match: /\/purchases$/, status: 400, body: { message: "paymentAccount is required for cash purchases" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase", { companySlug: "demo", date: "2026-09-01", kind: "cash_purchase", lines: [{ description: "x", netPrice: 1, vat: 0, account: "6540", vatType: "NONE" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("paymentAccount is required");
    expect(f.calls).toHaveLength(1);
  });

  it("attach_inbox_document attaches to an existing purchase", async () => {
    const f = fakeFiken([{ match: /\/purchases\/77\/attachments\?inboxDocumentId=9&attachToSale=true$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77/attachments/u" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "attach_inbox_document", { companySlug: "demo", purchaseId: 77, inboxDocumentId: 9 })).json()).toEqual({ purchaseId: 77, inboxDocumentId: 9 });
  });

  it("consequential tools are marked destructive and demand confirmation", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tools = (await c.listTools()).tools;
    for (const name of ["create_purchase", "attach_inbox_document"]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations?.destructiveHint, name).toBe(true);
      expect(t.description, name).toContain("explicit confirmation");
    }
    expect(tools.find((x) => x.name === "create_contact")?.description).toContain("explicit confirmation");
  });
});
