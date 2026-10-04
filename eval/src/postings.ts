export type Side = "debit" | "credit";

/** One side of a booking. net in øre; vat a rate ("25", "0", …), «kode N» for an unknown journal VAT code, or undefined; vatAmount the VAT added on top of net. */
export type Posting = { side: Side; account: string; net: number; vat: string | undefined; vatAmount: number };

/** What the model proposed: a write operation's name and args, from preview_booking or a blocked write call. */
export type Proposal = { operation: string; args: Record<string, unknown>; via: "preview" | "write" };

export type Converted = { postings: Posting[]; notes: string[] };

const TYPE_RATE: Record<string, string> = { HIGH: "25", MEDIUM: "15", LOW: "12", NONE: "0", EXEMPT: "0", OUTSIDE: "0", EXEMPT_IMPORT_EXPORT: "0" };
/** Journal VAT codes verified on Fiken 2026-10-05: 1 input VAT 25 %, 3 output VAT 25 %. */
const CODE_RATE: Record<number, string> = { 1: "25", 3: "25" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "?");
const recordLines = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** True for a plain rate ("25", "0"), false for «kode N» or no VAT. */
export const isRate = (vat: string | undefined): boolean => vat !== undefined && /^\d+$/.test(vat);
const vatOn = (net: number, vat: string | undefined): number => (isRate(vat) ? Math.round((net * Number(vat)) / 100) : 0);
const typeRate = (t: unknown): string | undefined => (typeof t === "string" ? (TYPE_RATE[t] ?? t) : undefined);
const post = (side: Side, account: string, net: number, vat?: string, vatAmount = 0): Posting => ({ side, account, net, vat, vatAmount });
const grossOf = (ps: Posting[]): number => ps.reduce((sum, x) => sum + x.net + x.vatAmount, 0);

function journal(args: Record<string, unknown>): Converted {
  const postings: Posting[] = [];
  const notes: string[] = [];
  for (const l of recordLines(args.lines)) {
    for (const side of ["debit", "credit"] as const) {
      const account = l[`${side}Account`];
      if (typeof account !== "string") continue;
      const code = l[`${side}VatCode`];
      let vat: string | undefined;
      if (typeof code === "number") {
        vat = CODE_RATE[code] ?? `kode ${code}`;
        if (CODE_RATE[code] === undefined) notes.push(`Mva-kode ${code} er ukjent for evalueringen; balansen er ikke sjekket.`);
      }
      const net = num(l.amount);
      postings.push(post(side, account, net, vat, vatOn(net, vat)));
    }
  }
  return { postings, notes };
}

function purchase(args: Record<string, unknown>): Converted {
  const debits = recordLines(args.lines).map((l) => post("debit", str(l.account), num(l.netPrice), typeRate(l.vatType), num(l.vat)));
  const account = args.kind === "cash_purchase" ? str(args.paymentAccount) : "2400";
  return { postings: [...debits, post("credit", account, grossOf(debits))], notes: [] };
}

function sale(args: Record<string, unknown>): Converted {
  const credits = recordLines(args.lines).map((l) => post("credit", str(l.account), num(l.netPrice), typeRate(l.vatType), num(l.vat)));
  const account = args.kind === "cash_sale" ? str(args.paymentAccount) : "1500";
  const notes = args.paymentFee !== undefined ? ["paymentFee er ikke med i posteringene."] : [];
  return { postings: [post("debit", account, grossOf(credits)), ...credits], notes };
}

function documentLines(v: unknown, side: Side, notes: string[]): Posting[] {
  return recordLines(v).map((l, i) => {
    if (typeof l.unitPrice !== "number") notes.push(`Linje ${i + 1} har ingen unitPrice (produkt); beløpet er ikke kjent.`);
    const net = Math.round(num(l.quantity) * num(l.unitPrice) * (1 - num(l.discount) / 100));
    const vat = typeRate(l.vatType);
    return post(side, str(l.incomeAccount), net, vat, vatOn(net, vat));
  });
}

function invoice(args: Record<string, unknown>): Converted {
  const notes: string[] = [];
  const credits = documentLines(args.lines, "credit", notes);
  const account = args.cash === true ? str(args.paymentAccount) : "1500";
  return { postings: [post("debit", account, grossOf(credits)), ...credits], notes };
}

function creditNote(args: Record<string, unknown>): Converted {
  if (args.kind === "full") return { postings: [], notes: ["Full kreditnota: posteringene er fakturaens, motsatt vei."] };
  const notes: string[] = [];
  const debits = documentLines(args.lines, "debit", notes);
  return { postings: [...debits, post("credit", "1500", grossOf(debits))], notes };
}

function payment(args: Record<string, unknown>): Converted {
  const amount = num(args.amount);
  const bank = str(args.account);
  const notes = args.fee !== undefined ? ["fee er ikke med i posteringene."] : [];
  const postings =
    args.saleId !== undefined
      ? [post("debit", bank, amount), post("credit", "1500", amount)]
      : [post("debit", "2400", amount), post("credit", bank, amount)];
  return { postings, notes };
}

export const CONVERTERS: Record<string, (args: Record<string, unknown>) => Converted> = {
  create_journal_entry: journal,
  create_purchase: purchase,
  create_sale: sale,
  create_invoice: invoice,
  create_credit_note: creditNote,
  register_payment: payment,
};

/** The proposal's postings, or undefined when its operation has no converter. */
export function toPostings(p: Proposal): Converted | undefined {
  const convert = CONVERTERS[p.operation];
  return convert ? convert(p.args) : undefined;
}
