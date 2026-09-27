import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { keyRingFromParameter, type KeyRing } from "./crypto/blob.js";

export interface Config {
  publicUrl: string;
  fikenClientId: string;
  fikenClientSecret: string;
  keys: KeyRing;
  userSalt: Buffer;
  fikenBaseUrl: string;
  fikenOAuthBaseUrl: string;
  fetch: typeof fetch;
}

export interface SsmLike {
  getParameters(names: string[]): Promise<Record<string, string>>;
}

const PARAM_NAMES = ["client_id", "client_secret", "signing_key", "user_salt"] as const;

export function ssmFromSdk(client = new SSMClient({})): SsmLike {
  return {
    async getParameters(names) {
      const out = await client.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
      const result: Record<string, string> = {};
      for (const p of out.Parameters ?? []) {
        if (p.Name && p.Value !== undefined) result[p.Name] = p.Value;
      }
      return result;
    },
  };
}

function saltFromHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("user_salt must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

export async function loadConfig(deps: { env?: NodeJS.ProcessEnv; ssm?: SsmLike; fetch?: typeof fetch } = {}): Promise<Config> {
  const env = deps.env ?? process.env;
  const publicUrl = env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!publicUrl) throw new Error("PUBLIC_URL is required");
  const prefix = env.PARAM_PREFIX ?? "/fiken_mcp";
  const names = PARAM_NAMES.map((n) => `${prefix}/${n}`);
  const params = await (deps.ssm ?? ssmFromSdk()).getParameters(names);
  const get = (n: (typeof PARAM_NAMES)[number]) => {
    const v = params[`${prefix}/${n}`];
    if (!v) throw new Error(`missing parameter ${prefix}/${n}`);
    return v;
  };
  return {
    publicUrl,
    fikenClientId: get("client_id"),
    fikenClientSecret: get("client_secret"),
    keys: keyRingFromParameter(get("signing_key")),
    userSalt: saltFromHex(get("user_salt")),
    fikenBaseUrl: "https://api.fiken.no/api/v2",
    fikenOAuthBaseUrl: "https://fiken.no/oauth",
    fetch: deps.fetch ?? globalThis.fetch,
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicUrl: "https://fiken-mcp.test",
    fikenClientId: "test-client-id",
    fikenClientSecret: "test-client-secret",
    keys: keyRingFromParameter(`t1:${"1".repeat(64)}`),
    userSalt: saltFromHex("2".repeat(64)),
    fikenBaseUrl: "https://api.fiken.test/api/v2",
    fikenOAuthBaseUrl: "https://fiken.test/oauth",
    fetch: async () => new Response("unexpected fetch", { status: 500 }),
    ...overrides,
  };
}
