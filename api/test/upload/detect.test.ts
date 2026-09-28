import { describe, expect, it } from "vitest";
import { detectType, safeFilename } from "../../src/upload/detect.js";

const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0]);
describe("detectType", () => {
  it("recognises pdf, png, jpeg and gif by magic bytes only", () => {
    expect(detectType(new TextEncoder().encode("%PDF-1.7 rest"))).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(detectType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ mime: "image/png", ext: "png" });
    expect(detectType(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(detectType(new TextEncoder().encode("GIF89a...."))).toEqual({ mime: "image/gif", ext: "gif" });
    expect(detectType(new TextEncoder().encode("<html>"))).toBeUndefined();
    expect(detectType(new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBeUndefined(); // HEIC
    expect(detectType(new Uint8Array(2))).toBeUndefined();
  });
});
describe("safeFilename", () => {
  it("keeps a plain name with the detected extension and strips paths and oddities", () => {
    expect(safeFilename("kvittering 12.pdf", "pdf")).toBe("kvittering12.pdf");
    expect(safeFilename("../../etc/passwd", "png")).toBe("passwd.png");
    expect(safeFilename("IMG_0042.HEIC", "jpg")).toBe("IMG_0042.jpg");
    expect(safeFilename("", "pdf")).toBe("receipt.pdf");
    expect(safeFilename(".pdf", "png")).toBe("receipt.png");
    expect(safeFilename(".", "pdf")).toBe("receipt.pdf");
    expect(safeFilename("a".repeat(200) + ".pdf", "pdf")).toHaveLength(80);
  });
});
