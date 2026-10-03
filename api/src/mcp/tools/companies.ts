import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { noteFikenError, toolError, toolJson } from "../context.js";

interface FikenCompany {
  name: string;
  slug: string;
  organizationNumber?: string;
  hasApiAccess?: boolean;
}

export const companiesOperations: Operation[] = [
  defineOperation({
    name: "list_companies",
    concept: "companies",
    kind: "read",
    destructive: false,
    title: "List companies",
    description:
      "Lists the Fiken companies the logged-in user is a member of, with the slug every other tool needs as companySlug. " +
      "hasApiAccess false means the company has not ordered Fiken's API module (done inside Fiken under Rediger konto, API); " +
      "other tools fail for that company until it is ordered. A company the user is not a member of in Fiken is not listed at all.",
    input: z.object({}),
    async run(ctx) {
      try {
        const companies = await ctx.fiken.json<FikenCompany[]>("/companies");
        return toolJson(
          companies.map((c) => ({ name: c.name, slug: c.slug, organizationNumber: c.organizationNumber, hasApiAccess: c.hasApiAccess })),
        );
      } catch (err) {
        return toolError(err, { loginValid: await noteFikenError(ctx, err) });
      }
    },
  }),
];
