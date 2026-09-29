import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

describe("attachments", () => {
  it("attach_inbox_document attaches to an existing purchase and always states what the document proves", async () => {
    const f = fakeFiken([{ match: /\/purchases\/77\/attachments\?inboxDocumentId=9&attachToSale=true&attachToPayment=false$/, status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/purchases/77/attachments/u" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "attach_inbox_document", { companySlug: "demo", purchaseId: 77, inboxDocumentId: 9 })).json()).toEqual({ purchaseId: 77, inboxDocumentId: 9 });
    const neither = await callJson(c, "attach_inbox_document", { companySlug: "demo", purchaseId: 77, inboxDocumentId: 9, attachToSale: false });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain("At least one of attachToSale and attachToPayment");
    expect(f.calls).toHaveLength(1);
  });

  it("attaches from the inbox to a sale and a journal entry", async () => {
    const f = fakeFiken([
      { match: /\/sales\/3\/attachments\?/, status: 201, headers: { location: "https://api.test/v2/companies/demo/sales/3/attachments/u1" } },
      { match: /\/journalEntries\/11\/attachments\?/, status: 201, headers: { location: "https://api.test/v2/companies/demo/journalEntries/11/attachments/u2" } },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "attach_inbox_document", { companySlug: "demo", saleId: 3, inboxDocumentId: 9 })).json()).toEqual({ saleId: 3, inboxDocumentId: 9 });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/sales/3/attachments?inboxDocumentId=9&attachToSale=true&attachToPayment=false");
    expect((await callJson(c, "attach_inbox_document", { companySlug: "demo", journalEntryId: 11, inboxDocumentId: 9 })).json()).toEqual({ journalEntryId: 11, inboxDocumentId: 9 });
    expect(f.calls[1]?.url).toBe("https://api.test/v2/companies/demo/journalEntries/11/attachments?inboxDocumentId=9");
  });

  it("copies an inbox document onto an invoice", async () => {
    const f = fakeFiken([
      { match: /\/inbox\/9$/, body: { documentId: 9, name: "timeliste", filename: "timeliste.pdf", documentUrl: "https://api.test/v2/files/f9" } },
      { match: /\/files\/f9$/, body: "PDFBYTES" },
      { match: /\/invoices\/77\/attachments$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/77/attachments/u3" } },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "attach_inbox_document", { companySlug: "demo", invoiceId: 77, inboxDocumentId: 9 });
    expect(r.json()).toEqual({ invoiceId: 77, inboxDocumentId: 9, note: "The file was copied onto the invoice; the inbox document stays in the inbox." });
    const form = f.calls[2]?.init?.body as FormData;
    expect(form.get("filename")).toBe("timeliste.pdf");
    expect((form.get("file") as File).name).toBe("timeliste.pdf");
  });

  it("refuses a documentUrl outside the Fiken API without sending the token", async () => {
    const f = fakeFiken([{ match: /\/inbox\/9$/, body: { documentId: 9, filename: "x.pdf", documentUrl: "https://evil.example/files/f9" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "attach_inbox_document", { companySlug: "demo", invoiceId: 77, inboxDocumentId: 9 });
    expect(r.isError).toBe(true);
    expect(f.calls.map((x) => x.url)).toEqual(["https://api.test/v2/companies/demo/inbox/9"]);
  });

  it("needs exactly one target, for both tools, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    for (const args of [{}, { purchaseId: 1, saleId: 2 }]) {
      const a = await callJson(c, "attach_inbox_document", { companySlug: "demo", inboxDocumentId: 9, ...args });
      expect(a.isError).toBe(true);
      expect(a.text).toBe("Give exactly one of purchaseId, saleId, invoiceId, journalEntryId.");
      expect((await callJson(c, "get_attachments", { companySlug: "demo", ...args })).isError).toBe(true);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("get_attachments lists and trims", async () => {
    const f = fakeFiken([{ match: /\/purchases\/8\/attachments$/, body: [{ uuid: "u", filename: "kvittering.jpg", type: "unspecified", identifier: "", comment: "", downloadUrl: "https://api.test/v2/files/u" }] }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "get_attachments", { companySlug: "demo", purchaseId: 8 })).json()).toEqual({
      items: [{ uuid: "u", filename: "kvittering.jpg", type: "unspecified", identifier: "", comment: "" }],
    });
  });
});
