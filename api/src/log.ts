export type LogFields = Record<string, string | number | boolean | undefined>;

const FORBIDDEN = [/^bearer\s/i, /^basic\s/i, /v1e?\.[A-Za-z0-9_-]+\./, /[^\s@]+@[^\s@]+\.[^\s@]+/];

function assertSafe(fields: LogFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;
    if (FORBIDDEN.some((re) => re.test(value))) {
      throw new Error(`refusing to log field ${key}: looks like a secret or personal data`);
    }
  }
}

export function log(event: string, fields: LogFields = {}): void {
  assertSafe(fields);
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
}

export function withRequestId(requestId: string) {
  return (event: string, fields: LogFields = {}) => log(event, { requestId, ...fields });
}
