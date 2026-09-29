import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const project = { projectId: 7, number: "P-1", name: "Bygg", description: "Nytt bygg", startDate: "2026-01-01", endDate: "2026-12-31", completed: false, contact: { contactId: 5, name: "Kunde AS", email: "x@x.no" } };
const product = { productId: 3, createdDate: "2020-01-01", lastModifiedDate: "2026-01-01", name: "Spade", productNumber: "125-1", unitPrice: 30000, incomeAccount: "3000", vatType: "HIGH", active: true, note: "Solid", stock: 5 };

describe("contact and product updates keep what they do not change", () => {
  it("update_contact overlays the given fields and sends the rest back", async () => {
    const current = { contactId: 5, createdDate: "2020-01-01", lastModifiedDate: "2026-01-01", name: "Kunde AS", email: "old@x.no", organizationNumber: "123",
      customerNumber: 10001, customer: true, supplier: false, inactive: false, bankAccountNumber: "12345678903", currency: "NOK", language: "NORWEGIAN",
      address: { streetAddress: "Gate 1", city: "Oslo", postCode: "0150", country: "Norge" }, notes: [{ x: 1 }], documents: [], contactPerson: [], groups: ["g"] };
    const f = fakeFiken([{ match: /\/contacts\/5$/, body: current }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "update_contact", { companySlug: "demo", contactId: 5, email: "new@x.no", address: { city: "Bergen" } });
    expect(r.isError).toBe(false);
    const put = f.calls.find((x) => x.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      name: "Kunde AS", email: "new@x.no", organizationNumber: "123", customer: true, supplier: false, inactive: false, bankAccountNumber: "12345678903",
      currency: "NOK", language: "NORWEGIAN", address: { streetAddress: "Gate 1", city: "Bergen", postCode: "0150", country: "Norge" }, groups: ["g"],
    });
    const before = f.calls.length;
    expect((await callJson(c, "update_contact", { companySlug: "demo", contactId: 5 })).isError).toBe(true);
    expect(f.calls).toHaveLength(before);
    await callJson(c, "update_contact", { companySlug: "demo", contactId: 5, currency: "EUR", memberNumberString: "M1" });
    const puts = f.calls.filter((x) => x.init?.method === "PUT");
    expect(JSON.parse(String(puts[1]?.init?.body))).toMatchObject({ currency: "EUR", memberNumberString: "M1" });
  });

  it("update_product sends the full product with one field changed", async () => {
    const f = fakeFiken([{ match: /\/products\/3$/, body: product }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "update_product", { companySlug: "demo", productId: 3, unitPrice: 35000 });
    expect(r.json()).toMatchObject({ productId: 3, name: "Spade", note: "Solid", stock: 5 });
    const put = f.calls.find((x) => x.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({ name: "Spade", productNumber: "125-1", unitPrice: 35000, incomeAccount: "3000", vatType: "HIGH", active: true, note: "Solid", stock: 5 });
    const before = f.calls.length;
    expect((await callJson(c, "update_product", { companySlug: "demo", productId: 3 })).isError).toBe(true);
    expect(f.calls).toHaveLength(before);
  });

  it("create_product defaults active to true and reads the product back", async () => {
    const f = fakeFiken([
      { match: /\/products$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/products/3" } },
      { match: /\/products\/3$/, body: product },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_product", { companySlug: "demo", name: "Spade", incomeAccount: "3000", vatType: "HIGH", unitPrice: 30000 });
    expect(r.json()).toMatchObject({ productId: 3, note: "Solid", stock: 5 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ name: "Spade", incomeAccount: "3000", vatType: "HIGH", active: true, unitPrice: 30000 });
  });
});

describe("projects", () => {
  it("create_project posts the body and reads the project back", async () => {
    const f = fakeFiken([
      { match: /\/projects$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/projects/7" } },
      { match: /\/projects\/7$/, body: project },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_project", { companySlug: "demo", number: "P-1", name: "Bygg", startDate: "2026-01-01", contactId: 5 });
    expect(r.json()).toEqual({ projectId: 7, number: "P-1", name: "Bygg", description: "Nytt bygg", startDate: "2026-01-01", endDate: "2026-12-31", completed: false, contact: { contactId: 5, name: "Kunde AS" } });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ number: "P-1", name: "Bygg", startDate: "2026-01-01", contactId: 5 });
  });

  it("create_project names the created project when the read-back fails", async () => {
    const f = fakeFiken([
      { match: /\/projects$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/projects/7" } },
      { match: /\/projects\/7$/, status: 500, body: "x" },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_project", { companySlug: "demo", number: "P-1", name: "Bygg", startDate: "2026-01-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Project 7 was created");
    expect(r.text).toContain("get_project");
  });

  it("update_project patches only the given fields and refuses an empty update before any call", async () => {
    const f = fakeFiken([
      { match: /\/projects\/7$/, body: { ...project, completed: true } },
    ]);
    const c = await connected(f.fetchImpl);
    const empty = await callJson(c, "update_project", { companySlug: "demo", projectId: 7 });
    expect(empty.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    const r = await callJson(c, "update_project", { companySlug: "demo", projectId: 7, completed: true });
    expect(r.json()).toMatchObject({ projectId: 7, completed: true });
    expect(f.calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ completed: true });
  });

  it("get_project trims the project", async () => {
    const f = fakeFiken([{ match: /\/projects\/7$/, body: project }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "get_project", { companySlug: "demo", projectId: 7 })).json()).toMatchObject({ projectId: 7, contact: { contactId: 5, name: "Kunde AS" } });
  });
});

describe("get_product and contact persons", () => {
  it("get_product adds note and stock to the list trim", async () => {
    const f = fakeFiken([{ match: /\/products\/3$/, body: product }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "get_product", { companySlug: "demo", productId: 3 })).json()).toEqual({
      productId: 3, name: "Spade", productNumber: "125-1", unitPrice: 30000, incomeAccount: "3000", vatType: "HIGH", active: true, note: "Solid", stock: 5,
    });
  });

  it("list_contact_persons trims the persons", async () => {
    const f = fakeFiken([{ match: /\/contacts\/5\/contactPerson$/, body: [{ contactPersonId: 1, name: "Betty", email: "b@x.no", phoneNumber: "1", address: { city: "Oslo" } }] }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_contact_persons", { companySlug: "demo", contactId: 5 })).json()).toEqual({ items: [{ contactPersonId: 1, name: "Betty", email: "b@x.no", phoneNumber: "1" }] });
  });

  it("add_contact_person requires an email", async () => {
    const f = fakeFiken([{ match: /\/contacts\/5\/contactPerson$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/contacts/5/contactPerson/12" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "add_contact_person", { companySlug: "demo", contactId: 5, name: "Betty" })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    const ok = await callJson(c, "add_contact_person", { companySlug: "demo", contactId: 5, name: "Betty", email: "b@x.no" });
    expect(ok.json()).toEqual({ contactPersonId: 12 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ name: "Betty", email: "b@x.no" });
  });
});
