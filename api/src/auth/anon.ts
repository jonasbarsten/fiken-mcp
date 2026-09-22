import { createHmac } from "node:crypto";

export function anonymousId(email: string, salt: Buffer): string {
  return createHmac("sha256", salt).update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}
