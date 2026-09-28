import { monthKey, type MonthRow, type UsageStore } from "./store.js";

type Row = Record<string, unknown> & { PK: string; SK: string };

function toMonthRow(row: Row, includeActiveUsers: boolean): MonthRow {
  const tools: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("tool#")) tools[k.slice("tool#".length)] = v as number;
  }
  const month = (row.SK as string).slice("MONTH#".length);
  const out: MonthRow = {
    month,
    calls: (row.calls as number) ?? 0,
    errors: (row.errors as number) ?? 0,
    tools,
  };
  if (includeActiveUsers) out.activeUsers = (row.activeUsers as number) ?? 0;
  return out;
}

export function memoryUsageStore(): UsageStore & { dump(): Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Row>();

  function bump(pk: string, sk: string, tool: string, ok: boolean, incrementActiveUsers: boolean) {
    const key = `${pk}|${sk}`;
    const row: Row = rows.get(key) ?? { PK: pk, SK: sk };
    row.calls = ((row.calls as number) ?? 0) + 1;
    row.errors = ((row.errors as number) ?? 0) + (ok ? 0 : 1);
    const toolAttr = `tool#${tool}`;
    row[toolAttr] = ((row[toolAttr] as number) ?? 0) + 1;
    if (incrementActiveUsers) row.activeUsers = ((row.activeUsers as number) ?? 0) + 1;
    rows.set(key, row);
  }

  return {
    async recordCall(anonId, tool, ok, now = new Date()) {
      const sk = monthKey(now);
      const isFirstThisMonth = !rows.has(`USER#${anonId}|${sk}`);
      bump(`USER#${anonId}`, sk, tool, ok, false);
      bump("GLOBAL", sk, tool, ok, isFirstThisMonth);
    },
    async recordFirstLogin(anonId, now = new Date()) {
      const key = `USER#${anonId}|PROFILE`;
      if (rows.has(key)) return;
      const firstSeen = now.toISOString().slice(0, 7);
      rows.set(key, { PK: `USER#${anonId}`, SK: "PROFILE", firstSeen });
      const globalKey = "GLOBAL|ALL";
      const g = rows.get(globalKey) ?? { PK: "GLOBAL", SK: "ALL" };
      g.totalUsers = ((g.totalUsers as number) ?? 0) + 1;
      rows.set(globalKey, g);
    },
    async userMonths(anonId) {
      const prefix = `USER#${anonId}|MONTH#`;
      const result: MonthRow[] = [];
      for (const [key, row] of rows) {
        if (key.startsWith(prefix)) result.push(toMonthRow(row, false));
      }
      result.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
      return result;
    },
    async globalStats() {
      const totalUsers = (rows.get("GLOBAL|ALL")?.totalUsers as number) ?? 0;
      const months: MonthRow[] = [];
      for (const [key, row] of rows) {
        if (key.startsWith("GLOBAL|MONTH#")) months.push(toMonthRow(row, true));
      }
      months.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
      return { totalUsers, months: months.slice(0, 24) };
    },
    dump() {
      return rows;
    },
  };
}
