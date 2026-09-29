import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const line = { text: "Kontorrekvisita", vatType: "HIGH", incomeAccount: "6800", net: 10000, gross: 12500 };
const draftLocation = { location: "https://api.test/v2/companies/demo/purchases/drafts/12" };
const purchase55 = {
  purchaseId: 55, date: "2026-09-29", kind: "supplier", paid: false, currency: "NOK",
  lines: [{ description: "Kontorrekvisita", netPrice: 10000, vat: 2500, account: "6800", vatType: "HIGH", lineId: 1 }],
  purchaseAttachments: [],
};

describe("purchase drafts", () => {
  it("create_purchase_draft sends the exact body and returns the draft id", async () => {
    const f = fakeFiken([{ match: /\/purchases\/drafts$/, status: 201, headers: draftLocation }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase_draft", { companySlug: "demo", cash: false, paid: false, contactId: 7, dueDate: "2026-10-13", lines: [line] });
    expect(r.json()).toEqual({ draftId: 12 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ cash: false, paid: false, currency: "NOK", contactId: 7, dueDate: "2026-10-13", lines: [line] });
  });

  it("create_purchase_draft refuses gross below net, a mistyped key and other currencies before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const base = { companySlug: "demo", cash: false, paid: false };
    const low = await callJson(c, "create_purchase_draft", { ...base, lines: [{ ...line, gross: 9000 }] });
    expect(low.isError).toBe(true);
    expect(low.text).toContain("gross");
    expect((await callJson(c, "create_purchase_draft", { ...base, lines: [{ ...line, Net: 1 }] })).isError).toBe(true);
    expect((await callJson(c, "create_purchase_draft", { ...base, currency: "EUR", lines: [line] })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("list_purchase_drafts trims the drafts", async () => {
    const f = fakeFiken([
      {
        match: /\/purchases\/drafts\?/,
        body: [{ draftId: 12, uuid: "u-1", invoiceIssueDate: "2026-09-29", dueDate: "2026-10-13", cash: false, paid: false, currency: "NOK", contact: { contactId: 7, name: "Leverandør AS", email: "x@y.no" }, lines: [{ text: "a" }, { text: "b" }], attachments: [{}] }],
      },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_purchase_drafts", { companySlug: "demo" });
    expect(r.json()).toMatchObject({
      items: [{ draftId: 12, uuid: "u-1", invoiceIssueDate: "2026-09-29", dueDate: "2026-10-13", contact: { contactId: 7, name: "Leverandør AS" }, cash: false, paid: false, lines: 2 }],
    });
    expect(JSON.stringify(r.json())).not.toContain("x@y.no");
  });

  it("create_purchase_from_draft sends no body and reads the purchase back", async () => {
    const f = fakeFiken([
      { match: /\/purchases\/drafts\/12\/createPurchase$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/purchases/55" } },
      { match: /\/purchases\/55$/, body: purchase55 },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase_from_draft", { companySlug: "demo", draftId: 12 });
    expect(r.json()).toMatchObject({ purchaseId: 55, lines: [{ description: "Kontorrekvisita", netPrice: 10000 }] });
    expect(JSON.stringify(r.json())).not.toContain("lineId");
    expect(f.calls[0]?.init?.method).toBe("POST");
    expect(f.calls[0]?.init?.body).toBeUndefined();
  });

  it("create_purchase_from_draft names the purchase when the read-back fails", async () => {
    const f = fakeFiken([
      { match: /\/purchases\/drafts\/12\/createPurchase$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/purchases/55" } },
      { match: /\/purchases\/55$/, status: 500, body: "x" },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_purchase_from_draft", { companySlug: "demo", draftId: 12 });
    expect(r.text).toContain("Purchase 55 was created");
    expect(r.text).toContain('call fiken_read with {"operation":"get_purchase"');
  });
});
