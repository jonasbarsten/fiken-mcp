import type { Case } from "./types.js";

const company = "fiken-demo-amerikansk-hytte-as3";
const replies = { company, default: "Ja, det stemmer. Bruk bankkontoen 1920:10001 og dagens dato." };
const OUTLAY = "https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md";
const TRAVEL = "https://hjelp.fiken.no/reiseregning-og-utlegg-for-ansatte.md";
const EMPLOYEE_DEBT = ["2910", "2911"];

export const OUTLAYS: Case[] = [
  {
    id: "utlegg-kontorrekvisita",
    area: "utlegg",
    prompt: "En ansatt kjøpte kontorrekvisita for 500 kr inkl. 25 % mva med privat kort. Før utlegget i demoforetaket; vi betaler henne tilbake senere.",
    replies,
    expect: {
      operations: ["create_journal_entry", "create_purchase"],
      postings: [
        { side: "debit", account: ["6800", "6810"], net: 40000, vat: "25" },
        { side: "credit", account: EMPLOYEE_DEBT, amount: 50000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: OUTLAY,
    reviewed: false,
  },
  {
    id: "utlegg-taxi",
    area: "utlegg",
    prompt: "En ansatt tok taxi til et kundemøte for 336 kr inkl. 12 % mva og betalte privat. Før utlegget i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry", "create_purchase"],
      postings: [
        { side: "debit", account: ["7140", "7130"], net: 30000, vat: "12" },
        { side: "credit", account: EMPLOYEE_DEBT, amount: 33600 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: TRAVEL,
    reviewed: false,
  },
  {
    id: "utlegg-porto",
    area: "utlegg",
    prompt: "En ansatt betalte 150 kr i porto privat. Porto har ikke mva. Før utlegget i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry", "create_purchase"],
      postings: [
        { side: "debit", account: ["6940"], net: 15000 },
        { side: "credit", account: EMPLOYEE_DEBT, amount: 15000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: OUTLAY,
    reviewed: false,
  },
  {
    id: "utlegg-hotell",
    area: "utlegg",
    prompt: "En ansatt betalte én hotellnatt på jobbreise privat, 1 120 kr inkl. 12 % mva. Før utlegget i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry", "create_purchase"],
      postings: [
        { side: "debit", account: ["7140", "7130"], net: 100000, vat: "12" },
        { side: "credit", account: EMPLOYEE_DEBT, amount: 112000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: TRAVEL,
    reviewed: false,
  },
  {
    id: "utlegg-tilbakebetaling",
    area: "utlegg",
    prompt: "Vi har betalt tilbake 500 kr til en ansatt for et utlegg, fra bankkontoen i dag. Før tilbakebetalingen i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry"],
      postings: [
        { side: "debit", account: EMPLOYEE_DEBT, amount: 50000 },
        { side: "credit", account: ["1920:10001"], amount: 50000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: OUTLAY,
    reviewed: false,
  },
];
