// pdfjs-dist ships no types for its worker module; pdf-text.ts only hands the module to pdf.js.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
