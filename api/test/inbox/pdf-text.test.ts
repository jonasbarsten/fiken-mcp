import { describe, expect, it } from "vitest";
import { MAX_PDF_PAGES, pdfPageTexts } from "../../src/inbox/pdf-text.js";
import { minimalPdf } from "../fixtures/pdf.js";

describe("pdfPageTexts", () => {
  it("returns each page's text and an empty string for a page without text", async () => {
    expect(await pdfPageTexts(minimalPdf(["Rema 1000 kr 125,00", null]))).toEqual({ pages: ["Rema 1000 kr 125,00", ""], numPages: 2 });
  });

  it("stops after MAX_PDF_PAGES pages but reports the full count", async () => {
    const r = await pdfPageTexts(minimalPdf(Array.from({ length: MAX_PDF_PAGES + 2 }, (_, i) => `side ${i + 1}`)));
    expect(r.numPages).toBe(MAX_PDF_PAGES + 2);
    expect(r.pages).toHaveLength(MAX_PDF_PAGES);
    expect(r.pages[MAX_PDF_PAGES - 1]).toBe(`side ${MAX_PDF_PAGES}`);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(pdfPageTexts(new TextEncoder().encode("%PDF-1.4 but broken"))).rejects.toThrow();
  });
});
