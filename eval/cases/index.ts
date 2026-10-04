import type { Case } from "./types.js";

export const ALL_CASES: Case[] = [];

/** All cases, the one with this id, or those in this area. */
export function selectCases(cases: Case[], filter?: string): Case[] {
  if (filter === undefined) return cases;
  const picked = cases.filter((c) => c.id === filter || c.area === filter);
  if (picked.length === 0) throw new Error(`Ingen sak eller område heter ${filter}.`);
  return picked;
}
