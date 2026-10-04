import type { Case } from "./types.js";

const company = "fiken-demo-amerikansk-hytte-as3";
const replies = { company, default: "Ja, det stemmer. Bruk bankkontoen 1920:10001 og dagens dato." };
const INVOICE = "https://hjelp.fiken.no/hvordan-lage-faktura-i-fiken.md";
const CORRECT = "https://hjelp.fiken.no/faktura-med-feil-slik-retter-du-den.md";
/** Demo company facts, checked 2026-10-04. */
const DEMOKUNDE = 818696461;

export const SALES: Case[] = [
  {
    id: "salg-faktura-radgivning",
    area: "salg",
    prompt: "Lag en faktura i demoforetaket til Demokunde for 10 timer rådgivning à 1 200 kr eks. mva, 25 % mva, forfall om 14 dager. Ikke send den.",
    replies,
    expect: {
      operations: ["create_invoice"],
      args: { customerId: DEMOKUNDE },
      postings: [
        { side: "credit", account: ["3020"], net: 1200000, vat: "25" },
        { side: "debit", account: ["1500*"], amount: 1500000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: INVOICE,
    reviewed: false,
  },
  {
    id: "salg-faktura-uten-mva",
    area: "salg",
    prompt: "Lag en faktura i demoforetaket til Demokunde for et kurs som er unntatt mva, 3 000 kr. Forfall om 14 dager. Ikke send den.",
    replies,
    expect: {
      // «Lag en faktura … ikke send den» may be an issued invoice or a draft. «Unntatt» (outside the VAT Act) is 3220, not «fritatt» 3120.
      operations: ["create_invoice", "create_invoice_draft"],
      args: { customerId: DEMOKUNDE },
      postings: [
        { side: "credit", account: ["3220"], net: 300000, vat: "0" },
        { side: "debit", account: ["1500*"], amount: 300000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: INVOICE,
    reviewed: false,
  },
  {
    id: "salg-kontant-vipps",
    area: "salg",
    prompt: "Vi solgte varer for 2 500 kr inkl. 25 % mva betalt med Vipps; pengene kom inn på bankkontoen i dag. Før salget i demoforetaket.",
    replies,
    expect: {
      operations: ["create_sale"],
      postings: [
        { side: "credit", account: ["3000"], net: 200000, vat: "25" },
        { side: "debit", account: ["1920:10001"], amount: 250000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: "https://hjelp.fiken.no/salg-med-vipps-bedrift.md",
    reviewed: false,
  },
  {
    id: "salg-kreditnota-full",
    area: "salg",
    prompt: "Kunden har reklamert på faktura 10004 i demoforetaket. Krediter hele fakturaen.",
    replies,
    expect: {
      operations: ["create_credit_note"],
      args: { kind: "full", invoiceId: 5191494236 },
      postings: [],
      behaviour: { previewFirst: true },
    },
    source: CORRECT,
    reviewed: false,
  },
  {
    id: "salg-kreditnota-delvis",
    area: "salg",
    prompt: "Gi Jonas Barsten AS 20 % avslag på faktura 10003 i demoforetaket (2 280 kr eks. mva, 25 % mva) som en kreditnota.",
    replies,
    expect: {
      operations: ["create_credit_note"],
      args: { kind: "partial", invoiceId: 5191494176 },
      postings: [
        { side: "debit", account: ["3020"], net: 45600, vat: "25" },
        { side: "credit", account: ["1500*"], amount: 57000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: CORRECT,
    reviewed: false,
  },
  {
    id: "salg-betaling-full",
    area: "salg",
    prompt: "Demokunde har betalt faktura 10001 i demoforetaket i sin helhet til bankkontoen i dag. Registrer betalingen.",
    replies,
    expect: {
      operations: ["register_payment"],
      args: { saleId: 818874095 },
      postings: [
        { side: "debit", account: ["1920:10001"], amount: 31250 },
        { side: "credit", account: ["1500*"], amount: 31250 },
      ],
      behaviour: { previewFirst: true },
    },
    source: "https://hjelp.fiken.no/faktura---oversikt-og-oppfoelging.md",
    reviewed: false,
  },
  {
    id: "salg-delbetaling",
    area: "salg",
    prompt: "Jonas Barsten AS har betalt 1 000 kr av faktura 10005 i demoforetaket til bankkontoen i dag. Registrer delbetalingen.",
    replies,
    expect: {
      operations: ["register_payment"],
      args: { saleId: 5191506351 },
      postings: [
        { side: "debit", account: ["1920:10001"], amount: 100000 },
        { side: "credit", account: ["1500*"], amount: 100000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: "https://hjelp.fiken.no/betalingen-stemmer-ikke-med-fakturaen.md",
    reviewed: false,
  },
];
