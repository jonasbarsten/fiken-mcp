import type { Case } from "./types.js";

const company = "fiken-demo-amerikansk-hytte-as3";
const replies = { company, default: "Ja, det stemmer. Bruk bankkontoen 1920:10001 og dagens dato." };
const PURCHASE = "https://hjelp.fiken.no/registrere-kjoep-og-utgifter.md";

export const PURCHASES: Case[] = [
  {
    id: "kjop-kontorrekvisita",
    area: "kjøp",
    prompt: "Kjøpte kontorrekvisita for 625 kr inkl. 25 % mva, betalt med firmakortet fra bankkontoen i dag. Før det i demoforetaket.",
    replies,
    expect: {
      operations: ["create_purchase", "create_journal_entry"],
      postings: [
        { side: "debit", account: ["6800", "6810"], net: 50000, vat: "25" },
        { side: "credit", account: ["1920:10001"], amount: 62500 },
      ],
      behaviour: { previewFirst: true },
    },
    source: PURCHASE,
    reviewed: false,
  },
  {
    id: "kjop-togbillett",
    area: "kjøp",
    prompt: "Togbillett til kundebesøk, 448 kr inkl. 12 % mva, betalt med firmakortet. Før det i demoforetaket.",
    replies,
    expect: {
      operations: ["create_purchase", "create_journal_entry"],
      postings: [
        { side: "debit", account: ["7140", "7130"], net: 40000, vat: "12" },
        { side: "credit", account: ["1920:10001"], amount: 44800 },
      ],
      behaviour: { previewFirst: true },
    },
    source: PURCHASE,
    reviewed: false,
  },
  {
    id: "kjop-porto",
    area: "kjøp",
    prompt: "Kjøpte frimerker for 220 kr med firmakortet. Porto har ikke mva. Før det i demoforetaket.",
    replies,
    expect: {
      operations: ["create_purchase", "create_journal_entry"],
      postings: [
        { side: "debit", account: ["6940"], net: 22000 },
        { side: "credit", account: ["1920:10001"], amount: 22000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: PURCHASE,
    reviewed: false,
  },
  {
    id: "kjop-leverandorfaktura",
    area: "kjøp",
    prompt: "Fikk faktura fra Domeneshop AS på 1 250 kr inkl. 25 % mva for domene og webhotell, forfall om 14 dager. Før den i demoforetaket.",
    replies,
    expect: {
      operations: ["create_purchase"],
      postings: [
        { side: "debit", account: ["6420", "6550", "6551", "6553"], net: 100000, vat: "25" },
        { side: "credit", account: ["2400*"], amount: 125000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: PURCHASE,
    reviewed: false,
  },
  {
    id: "kjop-blandet-mva",
    area: "kjøp",
    prompt: "Kvittering fra Rema betalt med firmakortet: matvarer til personalmøte 230 kr inkl. 15 % mva og tørkepapir 125 kr inkl. 25 % mva. Før den i demoforetaket.",
    replies,
    expect: {
      operations: ["create_purchase", "create_journal_entry"],
      postings: [
        { side: "debit", account: ["5*", "6*", "7*"], net: 20000, vat: "15" },
        { side: "debit", account: ["5*", "6*", "7*"], net: 10000, vat: "25" },
        { side: "credit", account: ["1920:10001"], amount: 35500 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: PURCHASE,
    reviewed: false,
  },
  {
    id: "kjop-forsikring",
    area: "kjøp",
    prompt: "Betalte årspremie for bedriftsforsikring, 4 800 kr, fra bankkontoen. Forsikring har ikke mva. Før det i demoforetaket.",
    replies,
    expect: {
      operations: ["create_purchase", "create_journal_entry"],
      postings: [
        { side: "debit", account: ["7500"], net: 480000 },
        { side: "credit", account: ["1920:10001"], amount: 480000 },
      ],
      behaviour: { previewFirst: true },
    },
    source: "https://hjelp.fiken.no/forsikringer.md",
    reviewed: false,
  },
  {
    id: "kjop-mobilregning",
    area: "kjøp",
    prompt: "Mobilregningen på 499 kr inkl. 25 % mva ble trukket fra bankkontoen. Før den i demoforetaket.",
    replies,
    expect: {
      operations: ["create_purchase", "create_journal_entry"],
      postings: [
        { side: "debit", account: ["6900"], net: 39920, vat: "25" },
        { side: "credit", account: ["1920:10001"], amount: 49900 },
      ],
      behaviour: { previewFirst: true },
    },
    source: PURCHASE,
    reviewed: false,
  },
];
