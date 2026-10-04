export type Area = "kjøp" | "utlegg" | "salg" | "bilag";

/** One posting a case expects. account: exact codes, or a prefix ending in * (1920* matches 1920:10001). Amounts in øre. */
export type Expected = {
  side: "debit" | "credit";
  account: string[];
  /** Net amount (before VAT). */
  net?: number;
  /** Gross amount (net plus VAT). */
  amount?: number;
  /** VAT rate: "25", "15", "12" or "0". */
  vat?: string;
};

export type Replies = {
  /** The companySlug the simulated user chooses. */
  company: string;
  /** Answers for ask_user_form, by field name. */
  form?: Record<string, string>;
  /** Answers for ask_user_choice by a fragment of the question: option value or label. */
  choices?: Record<string, string>;
  /** The answer to anything else. */
  default: string;
};

export type Case = {
  id: string;
  area: Area;
  prompt: string;
  replies: Replies;
  expect: {
    operations: string[];
    postings: Expected[];
    /** Args that must equal these values (compared as JSON). */
    args?: Record<string, unknown>;
    /** Default true: no posting beyond the expected ones. */
    exact?: boolean;
    behaviour?: { previewFirst?: boolean; askChoice?: boolean; readHelp?: boolean };
  };
  /** The hjelp.fiken.no article the expected booking follows. */
  source: string;
  /** False until an accountant has checked the case. */
  reviewed: boolean;
};
