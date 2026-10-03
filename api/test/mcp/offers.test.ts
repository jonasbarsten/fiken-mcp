import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const line = { description: "Timer", quantity: 3, unitPrice: 100000, vatType: "HIGH", incomeAccount: "3000" };
const base = { companySlug: "demo", customerId: 7, daysUntilDueDate: 14 };

/** An invoiceishDraftResult of the given type, with fields the trim leaves out. */
const draftOf = (type: string, draftId: number) => ({
  draftId, uuid: `u-${draftId}`, type, lastModifiedDate: "2026-09-28", issueDate: "2026-09-29", daysUntilDueDate: 14, invoiceText: "Takk", currency: "NOK",
  lines: [{ description: "Timer", quantity: 3, unitPrice: 100000, vatType: "HIGH", incomeAccount: "3000" }], net: 300000, gross: 375000,
  customers: [{ contactId: 7, name: "Kunde AS" }], attachments: [],
});
const trimmedDraft = (type: string, draftId: number) => ({
  draftId, uuid: `u-${draftId}`, type, issueDate: "2026-09-29", daysUntilDueDate: 14, customerId: 7, currency: "NOK", net: 300000, gross: 375000, lines: 1,
});

describe("offers", () => {
  it("list_offer_drafts pages and trims each draft", async () => {
    const f = fakeFiken([{ match: /\/offers\/drafts\?/, body: [draftOf("offer", 31)], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_offer_drafts", { companySlug: "demo", page: 1, pageSize: 10 })).json()).toEqual({
      items: [trimmedDraft("offer", 31)], total: 1, page: 1, pageSize: 10,
    });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/offers/drafts?page=1&pageSize=10");
  });

  it("create_offer_draft posts type offer, with the bank account optional", async () => {
    const f = fakeFiken([{ match: /\/offers\/drafts$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/offers/drafts/31" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_offer_draft", { ...base, currency: "NOK", lines: [line] });
    expect(r.json()).toEqual({ draftId: 31 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ type: "offer", customerId: 7, daysUntilDueDate: 14, currency: "NOK", lines: [line] });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/offers/drafts");
  });

  it("create_offer_draft refuses a mistyped line key and an incomplete line before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_offer_draft", { ...base, lines: [{ ...line, unitprice: 1 }] })).isError).toBe(true);
    expect((await callJson(c, "create_offer_draft", { ...base, lines: [{ quantity: 1, description: "x" }] })).text).toContain("no productId");
    expect(f.calls).toHaveLength(0);
  });

  it("create_offer_from_draft sends no body and returns the offer id from the Location", async () => {
    const f = fakeFiken([{ match: /\/offers\/drafts\/31\/createOffer$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/offers/44" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_offer_from_draft", { companySlug: "demo", draftId: 31 })).json()).toEqual({ offerId: 44 });
    expect(f.calls[0]?.init?.body).toBeUndefined();
  });

  it("send_offer defaults to auto with attachments", async () => {
    const f = fakeFiken([{ match: /\/offers\/send$/, status: 200 }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "send_offer", { companySlug: "demo", offerId: 44 })).json()).toEqual({ offerId: 44, sent: true, method: ["auto"] });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ offerId: 44, method: ["auto"], includeDocumentAttachments: true });
  });

  it("list_offers trims", async () => {
    const offer = { offerId: 44, offerNumber: 2, date: "2026-09-29", net: 100, vat: 25, gross: 125, currency: "NOK", contactId: 7, comment: "x", lines: [], archived: false, accepted: "2026-09-30" };
    const f = fakeFiken([{ match: /\/offers\?/, body: [offer], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_offers", { companySlug: "demo" })).json()).toEqual({
      items: [{ offerId: 44, offerNumber: 2, date: "2026-09-29", net: 100, vat: 25, gross: 125, currency: "NOK", contactId: 7, archived: false, accepted: "2026-09-30" }],
      total: 1, page: 0, pageSize: 25,
    });
  });
});

describe("order confirmations", () => {
  it("list_order_confirmation_drafts pages and trims each draft", async () => {
    const f = fakeFiken([{ match: /\/orderConfirmations\/drafts\?/, body: [draftOf("order_confirmation", 51)], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_order_confirmation_drafts", { companySlug: "demo" })).json()).toEqual({
      items: [trimmedDraft("order_confirmation", 51)], total: 1, page: 0, pageSize: 25,
    });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/orderConfirmations/drafts?page=0&pageSize=25");
  });

  it("create_order_confirmation_draft posts type order_confirmation", async () => {
    const f = fakeFiken([{ match: /\/orderConfirmations\/drafts$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/orderConfirmations/drafts/51" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_order_confirmation_draft", { ...base, lines: [line] })).json()).toEqual({ draftId: 51 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toMatchObject({ type: "order_confirmation", customerId: 7 });
  });

  it("create_order_confirmation_from_draft returns confirmationId", async () => {
    const f = fakeFiken([{ match: /\/orderConfirmations\/drafts\/51\/createOrderConfirmation$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/orderConfirmations/61" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_order_confirmation_from_draft", { companySlug: "demo", draftId: 51 })).json()).toEqual({ confirmationId: 61 });
  });

  it("list_order_confirmations trims", async () => {
    const oc = { confirmationId: 61, confirmationNumber: 4, date: "2026-09-29", net: 100, vat: 25, gross: 125, currency: "NOK", contactId: 7, createdInvoice: 9, archived: false, internalComment: "x", lines: [] };
    const f = fakeFiken([{ match: /\/orderConfirmations\?/, body: [oc], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_order_confirmations", { companySlug: "demo" })).json()).toEqual({
      items: [{ confirmationId: 61, confirmationNumber: 4, date: "2026-09-29", net: 100, vat: 25, gross: 125, currency: "NOK", contactId: 7, createdInvoice: 9, archived: false }],
      total: 1, page: 0, pageSize: 25,
    });
  });

  it("create_invoice_draft_from_order_confirmation returns draftId", async () => {
    const f = fakeFiken([{ match: /\/orderConfirmations\/61\/createInvoiceDraft$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/drafts/71" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_invoice_draft_from_order_confirmation", { companySlug: "demo", confirmationId: 61 })).json()).toEqual({ draftId: 71 });
  });
});

describe("explore", () => {
  it("lists the new concepts with their operations", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const explore = async (path: string) => {
      const r = await c.callTool({ name: "fiken_explore", arguments: { path } });
      return JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? "") as { operations: Array<{ name: string }> };
    };
    expect((await explore("offers")).operations.map((o) => o.name).sort()).toEqual(["create_offer_draft", "create_offer_from_draft", "list_offer_drafts", "list_offers", "send_offer"]);
    expect((await explore("order_confirmations")).operations.map((o) => o.name).sort()).toEqual([
      "create_invoice_draft_from_order_confirmation", "create_order_confirmation_draft", "create_order_confirmation_from_draft",
      "list_order_confirmation_drafts", "list_order_confirmations",
    ]);
  });
});
