import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const line = { description: "Abonnement", quantity: 1, unitPrice: 50000, vatType: "HIGH", incomeAccount: "3000" };
const base = { companySlug: "demo", customerId: 7, daysUntilDueDate: 14, bankAccountNumber: "11112233334", lines: [line] };
const frequency = { interval: 1, intervalUnit: "MONTH" };

describe("recurring invoices", () => {
  it("create_invoice_draft refuses a repeating_invoice without startDate or frequency before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const noFrequency = await callJson(c, "create_invoice_draft", { ...base, type: "repeating_invoice", startDate: "2026-10-01" });
    expect(noFrequency.isError).toBe(true);
    expect(noFrequency.text).toContain("frequency");
    const noStart = await callJson(c, "create_invoice_draft", { ...base, type: "repeating_invoice", frequency });
    expect(noStart.isError).toBe(true);
    expect(noStart.text).toContain("startDate");
    expect((await callJson(c, "create_invoice_draft", { ...base, type: "repeating_invoice", startDate: "2026-10-01", frequency: { interval: 0, intervalUnit: "MONTH" } })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("create_invoice_draft refuses schedule fields on other types", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_invoice_draft", { ...base, type: "invoice", startDate: "2026-10-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("repeating_invoice");
    expect(f.calls).toHaveLength(0);
  });

  it("create_invoice_draft posts type, startDate, endDate and frequency for a repeating_invoice", async () => {
    const f = fakeFiken([{ match: /\/invoices\/drafts$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/drafts/81" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_invoice_draft", { ...base, type: "repeating_invoice", startDate: "2026-10-01", endDate: "2027-10-01", frequency });
    expect(r.json()).toEqual({ draftId: 81 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
      type: "repeating_invoice", customerId: 7, daysUntilDueDate: 14, bankAccountNumber: "11112233334", currency: "NOK", lines: [line],
      startDate: "2026-10-01", endDate: "2027-10-01", frequency,
    });
  });

  it("create_recurring_invoice_from_draft sends no body and returns the id from the Location", async () => {
    const f = fakeFiken([{ match: /\/invoices\/drafts\/81\/createRecurringInvoice$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/recurringInvoices/91" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_recurring_invoice_from_draft", { companySlug: "demo", draftId: 81 })).json()).toEqual({ recurringInvoiceId: 91 });
    expect(f.calls[0]?.init?.body).toBeUndefined();
  });

  it("list_recurring_invoices filters and trims to the job ids and status", async () => {
    const job = {
      jobId: 5, active: true, customerId: 7, nextDate: "2026-11-01", endDate: "2027-10-01", frequency, net: 50000, gross: 62500, currency: "NOK",
      generatedInvoiceIds: [1, 2], bankAccountNumber: "11112233334", lines: [{}], recipients: { ehf: true },
    };
    const ri = { recurringInvoiceId: 91, active: true, createdDate: "2026-10-01", daysUntilDueDate: 14, description: "Drift", invoiceDraftUuid: "u", jobs: [job] };
    const f = fakeFiken([{ match: /\/recurringInvoices\?/, body: [ri], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_recurring_invoices", { companySlug: "demo", customerId: 7, active: true });
    expect(r.json()).toEqual({
      items: [{
        recurringInvoiceId: 91, active: true, createdDate: "2026-10-01", daysUntilDueDate: 14, description: "Drift",
        jobs: [{ jobId: 5, active: true, customerId: 7, nextDate: "2026-11-01", endDate: "2027-10-01", frequency, net: 50000, gross: 62500, currency: "NOK", invoices: 2 }],
      }],
      total: 1, page: 0, pageSize: 25,
    });
    expect(f.calls[0]?.url).toContain("customerId=7");
    expect(f.calls[0]?.url).toContain("active=true");
  });

  it("set_recurring_invoice_job posts to the path of each action", async () => {
    const f = fakeFiken([{ match: /\/recurringInvoices\/91\/jobs\/5\/(pause|resume|stop)$/, status: 200 }]);
    const c = await connected(f.fetchImpl);
    for (const action of ["pause", "resume", "stop"]) {
      const r = await callJson(c, "set_recurring_invoice_job", { companySlug: "demo", recurringInvoiceId: 91, jobId: 5, action });
      expect(r.json()).toEqual({ recurringInvoiceId: 91, jobId: 5, action });
    }
    expect(f.calls.map((x) => x.url)).toEqual(["pause", "resume", "stop"].map((a) => `https://api.test/v2/companies/demo/recurringInvoices/91/jobs/5/${a}`));
    expect(f.calls.every((x) => x.init?.method === "POST")).toBe(true);
    expect((await callJson(c, "set_recurring_invoice_job", { companySlug: "demo", recurringInvoiceId: 91, jobId: 5, action: "delete" })).isError).toBe(true);
    expect(f.calls).toHaveLength(3);
  });

  it("set_recurring_invoice_job says to check the id on a 404 for a known company", async () => {
    const f = fakeFiken([
      { match: /\/jobs\/5\/pause$/, status: 404, body: "not found" },
      { match: /\/companies$/, body: [{ slug: "demo", name: "Demo" }] },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "set_recurring_invoice_job", { companySlug: "demo", recurringInvoiceId: 91, jobId: 5, action: "pause" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("The company exists; check the id you passed.");
  });
});

describe("time tracking", () => {
  it("list_time_users and list_activities trim", async () => {
    const f = fakeFiken([
      { match: /\/timeUsers\?/, body: [{ timeUserId: 3, name: "Ola", email: "ola@example.com", createdDate: "x", lastModifiedDate: "y" }], headers: { "fiken-api-result-count": "1" } },
      {
        match: /\/activities\?/,
        body: [{ activityId: 4, name: "Utvikling", description: "d", billable: true, hourlyRate: 125000, archived: false, product: { productId: 12, name: "P" }, project: { projectId: 8, name: "Q" } }],
        headers: { "fiken-api-result-count": "1" },
      },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_time_users", { companySlug: "demo", name: "Ola" })).json()).toEqual({
      items: [{ timeUserId: 3, name: "Ola", email: "ola@example.com" }], total: 1, page: 0, pageSize: 25,
    });
    expect(f.calls[0]?.url).toContain("name=Ola");
    expect((await callJson(c, "list_activities", { companySlug: "demo" })).json()).toEqual({
      items: [{ activityId: 4, name: "Utvikling", description: "d", billable: true, hourlyRate: 125000, archived: false, productId: 12, projectId: 8 }],
      total: 1, page: 0, pageSize: 25,
    });
  });

  it("list_time_entries filters and trims", async () => {
    const entry = {
      timeEntryId: 6, date: "2026-09-29", hours: 7.5, description: "Arbeid", internalNote: "n", startTime: "09:00", endTime: "16:30", invoiced: false, locked: false,
      activity: { activityId: 4, name: "Utvikling" }, project: { projectId: 8, name: "Q" }, timeUser: { timeUserId: 3, name: "Ola" },
    };
    const f = fakeFiken([{ match: /\/timeEntries\?/, body: [entry], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_time_entries", { companySlug: "demo", dateGe: "2026-09-01", dateLe: "2026-09-30", invoiced: false, timeUserId: 3 });
    expect(r.json()).toEqual({
      items: [{
        timeEntryId: 6, date: "2026-09-29", hours: 7.5, description: "Arbeid", internalNote: "n", startTime: "09:00", endTime: "16:30", invoiced: false, locked: false,
        activityId: 4, activityName: "Utvikling", projectId: 8, timeUserId: 3, timeUserName: "Ola",
      }],
      total: 1, page: 0, pageSize: 25,
    });
    for (const p of ["dateGe=2026-09-01", "dateLe=2026-09-30", "invoiced=false", "timeUserId=3"]) expect(f.calls[0]?.url).toContain(p);
  });

  it("create_time_entry refuses hours 0 before any call and posts the entry otherwise", async () => {
    const f = fakeFiken([{ match: /\/timeEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/timeEntries/6" } }]);
    const c = await connected(f.fetchImpl);
    const entry = { companySlug: "demo", date: "2026-09-29", activityId: 4, timeUserId: 3 };
    expect((await callJson(c, "create_time_entry", { ...entry, hours: 0 })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    const r = await callJson(c, "create_time_entry", { ...entry, hours: 7.5, description: "Arbeid", startTime: "09:00" });
    expect(r.json()).toEqual({ timeEntryId: 6 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ date: "2026-09-29", hours: 7.5, activityId: 4, timeUserId: 3, description: "Arbeid", startTime: "09:00" });
  });

  it("create_invoice_draft_from_time_entries posts the exact body and returns the draft id", async () => {
    const f = fakeFiken([{ match: /\/timeEntries\/createInvoiceDraft$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/drafts/71" } }]);
    const c = await connected(f.fetchImpl);
    const args = { companySlug: "demo", timeEntryIds: [6, 7], customerId: 7, daysUntilDueDate: 14, bankAccountNumber: "11112233334", groupBy: "activityAndPerson", includeTimeEntryDescriptions: true, issueDate: "2026-09-30", projectId: 8, invoiceText: "Timer", yourReference: "Ola", ourReference: "Kari" };
    expect((await callJson(c, "create_invoice_draft_from_time_entries", { ...args, timeEntryIds: [] })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect((await callJson(c, "create_invoice_draft_from_time_entries", args)).json()).toEqual({ draftId: 71 });
    const { companySlug: _slug, ...body } = args;
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ ...body, currency: "NOK" });
    await callJson(c, "create_invoice_draft_from_time_entries", { companySlug: "demo", timeEntryIds: [6], customerId: 7, daysUntilDueDate: 14, bankAccountNumber: "11112233334" });
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({
      timeEntryIds: [6], customerId: 7, daysUntilDueDate: 14, bankAccountNumber: "11112233334", currency: "NOK",
    });
  });
});

describe("explore", () => {
  it("lists the new concepts with their operations", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const explore = async (path: string) => {
      const r = await c.callTool({ name: "fiken_explore", arguments: { path } });
      return JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? "") as { operations: Array<{ name: string }> };
    };
    expect((await explore("recurring_invoices")).operations.map((o) => o.name).sort()).toEqual([
      "create_recurring_invoice_from_draft", "list_recurring_invoices", "set_recurring_invoice_job",
    ]);
    expect((await explore("time_tracking")).operations.map((o) => o.name).sort()).toEqual([
      "create_invoice_draft_from_time_entries", "create_time_entry", "list_activities", "list_time_entries", "list_time_users",
    ]);
  });
});
