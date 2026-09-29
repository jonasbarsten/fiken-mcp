import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";

export const usageOperations: Operation[] = [
  defineOperation({
    name: "my_usage",
    concept: "usage",
    kind: "read",
    destructive: false,
    title: "My usage",
    description:
      "Your own pseudonymous monthly call counts on this server: total calls, errors, and a breakdown by tool, for the last " +
      "24 months. anonId is a stable pseudonym derived from your Fiken login; nothing else about you or your accounting data " +
      "is stored. The same counters, summed across every user, are published publicly at GET /stats.",
    input: z.object({}),
    async run(ctx) {
      const months = await ctx.usage.userMonths(ctx.anonId);
      return toolJson({ anonId: ctx.anonId, months });
    },
  }),
];
