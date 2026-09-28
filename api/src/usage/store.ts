export interface MonthRow {
  month: string;
  calls: number;
  errors: number;
  tools: Record<string, number>;
  activeUsers?: number;
}

export interface UsageStore {
  /** Two ADD updates: USER#/MONTH# and GLOBAL/MONTH#. activeUsers increments when the user had no row for the month. */
  recordCall(anonId: string, tool: string, ok: boolean, now?: Date): Promise<void>;
  /** Conditional PROFILE put; on first success GLOBAL/ALL totalUsers += 1. */
  recordFirstLogin(anonId: string, now?: Date): Promise<void>;
  userMonths(anonId: string): Promise<MonthRow[]>; // newest first
  globalStats(): Promise<{ totalUsers: number; months: MonthRow[] }>; // newest first, at most 24
}

export const monthKey = (d: Date) => `MONTH#${d.toISOString().slice(0, 7)}`;
