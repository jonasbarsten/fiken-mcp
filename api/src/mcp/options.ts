import { CONCEPTS, type Concept, type Operation } from "./operations.js";
import { OPERATIONS } from "./registry.js";

/** What a connection may see, read from the URL path on every request (`/mcp/readonly`, `/mcp/invoices,sales`). */
export interface ConnectorOptions {
  readOnly: boolean;
  concepts?: ReadonlySet<Concept>;
}

const CONCEPT_NAMES = Object.keys(CONCEPTS) as Concept[];

/** "" → everything; "readonly" → reads only; "invoices,sales" → those concepts; "invoices,readonly" → both. */
export function parseConnectorOptions(segment: string): { ok: ConnectorOptions } | { error: string } {
  let readOnly = false;
  const concepts = new Set<Concept>();
  for (const word of segment.split(",").map((w) => w.trim().toLowerCase()).filter((w) => w !== "")) {
    if (word === "readonly") readOnly = true;
    else if ((CONCEPT_NAMES as string[]).includes(word)) concepts.add(word as Concept);
    else return { error: `Unknown connector option "${word}". Use readonly and any of: ${CONCEPT_NAMES.join(", ")}.` };
  }
  return { ok: concepts.size > 0 ? { readOnly, concepts } : { readOnly } };
}

/**
 * Every read, always: other operations take their slugs and ids from reads in any concept. A concept
 * filter chooses which areas the model may change, so writes show only for the chosen concepts, and
 * never when read-only.
 */
export function visibleOperations(options: ConnectorOptions): readonly Operation[] {
  const { readOnly, concepts } = options;
  return OPERATIONS.filter((op) => op.kind === "read" || (!readOnly && (!concepts || concepts.has(op.concept))));
}
