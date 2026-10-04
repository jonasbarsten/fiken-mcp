import type { Case } from "./types.js";

const company = "fiken-demo-amerikansk-hytte-as3";
const replies = { company, default: "Ja, det stemmer. Bruk bankkontoen 1920:10001 og dagens dato." };

export const JOURNAL: Case[] = [
  {
    id: "bilag-lan-fra-eier",
    area: "bilag",
    prompt: "Eieren har satt inn 50 000 kr på bankkontoen som et lån til selskapet. Før det i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry"],
      postings: [
        { side: "debit", account: ["1920:10001"], amount: 5000000 },
        { side: "credit", account: ["2255", "2915"], amount: 5000000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: "https://hjelp.fiken.no/innskudd-fra-eiere-i-as-emisjon-aksjekapital-eller-laan.md",
    reviewed: false,
  },
  {
    id: "bilag-bankgebyr",
    area: "bilag",
    prompt: "Banken trakk 89 kr i gebyr fra bankkontoen. Før det i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry", "create_purchase"],
      postings: [
        { side: "debit", account: ["7770"], amount: 8900 },
        { side: "credit", account: ["1920:10001"], amount: 8900 },
      ],
      behaviour: { previewFirst: true },
    },
    source: "https://hjelp.fiken.no/hvordan-registrere-gebyr.md",
    reviewed: false,
  },
  {
    id: "bilag-renteinntekt",
    area: "bilag",
    prompt: "Vi fikk 312 kr i renter på bankkontoen. Før det i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry"],
      postings: [
        { side: "debit", account: ["1920:10001"], amount: 31200 },
        { side: "credit", account: ["8051"], amount: 31200 },
      ],
      behaviour: { previewFirst: true },
    },
    source: "https://hjelp.fiken.no/fri-postering.md",
    reviewed: false,
  },
  {
    id: "bilag-omklassifisering",
    area: "bilag",
    prompt: "Vi førte 1 500 kr på konto 6800 Kontorrekvisita som skulle vært på 6553 Programvare. Rett det med en postering i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry"],
      postings: [
        { side: "debit", account: ["6553"], amount: 150000 },
        { side: "credit", account: ["6800"], amount: 150000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: "https://hjelp.fiken.no/feil-regnskapskonto-paa-et-kjoep-eller-salg.md",
    reviewed: false,
  },
  {
    id: "bilag-periodisering",
    area: "bilag",
    prompt: "Vi betalte 12 000 kr for et årsabonnement på programvare i januar og førte det som forskuddsbetalt kostnad. Før oktobers del, 1 000 kr, som kostnad i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry"],
      postings: [
        { side: "debit", account: ["6553"], amount: 100000 },
        { side: "credit", account: ["1749"], amount: 100000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: "https://hjelp.fiken.no/periodisere-inntekter-og-kostnader.md",
    reviewed: false,
  },
  {
    id: "bilag-avskrivning",
    area: "bilag",
    prompt: "Før årets avskrivning på inventar, 6 000 kr, mot konto 1250 i demoforetaket.",
    replies,
    expect: {
      operations: ["create_journal_entry"],
      postings: [
        { side: "debit", account: ["6017"], amount: 600000 },
        { side: "credit", account: ["1250"], amount: 600000 },
      ],
      behaviour: { previewFirst: true, readHelp: true },
    },
    source: "https://hjelp.fiken.no/regnskapsmessige-og-skattemessige-avskrivninger.md",
    reviewed: false,
  },
];
