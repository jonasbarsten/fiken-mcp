import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { dynamoUsageStore } from "../../src/usage/dynamo.js";

type Sent = { name: string; input: Record<string, unknown> };
function fakeClient(answers: Array<unknown | Error>) {
  const sent: Sent[] = [];
  return {
    sent,
    async send(command: unknown) {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: c.constructor.name, input: c.input });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  };
}
const sep = new Date("2026-09-15T10:00:00Z");

describe("dynamoUsageStore", () => {
  it("recordCall issues two ADD updates and increments activeUsers only on the user's first call of the month", async () => {
    const client = fakeClient([{}, {}, { Attributes: { calls: 3 } }, {}]);
    const s = dynamoUsageStore(client, "fiken-mcp-usage");
    await s.recordCall("anon1", "list_companies", false, sep);
    await s.recordCall("anon1", "list_companies", true, sep);
    expect(client.sent.map((x) => x.name)).toEqual(["UpdateCommand", "UpdateCommand", "UpdateCommand", "UpdateCommand"]);
    const [u1, g1, , g2] = client.sent;
    expect(u1!.input).toMatchObject({
      TableName: "fiken-mcp-usage",
      Key: { PK: "USER#anon1", SK: "MONTH#2026-09" },
      UpdateExpression: "ADD calls :one, errors :err, #t :one",
      ExpressionAttributeNames: { "#t": "tool#list_companies" },
      ExpressionAttributeValues: { ":one": 1, ":err": 1 },
      ReturnValues: "ALL_OLD",
    });
    expect(g1!.input).toMatchObject({
      Key: { PK: "GLOBAL", SK: "MONTH#2026-09" },
      UpdateExpression: "ADD calls :one, errors :err, #t :one, activeUsers :one",
    });
    expect(g2!.input).toMatchObject({ UpdateExpression: "ADD calls :one, errors :err, #t :one", ExpressionAttributeValues: { ":one": 1, ":err": 0 } });
    expect(new UpdateCommand(u1!.input as never)).toBeInstanceOf(UpdateCommand);
  });

  it("recordFirstLogin puts the profile once and bumps totalUsers only then", async () => {
    const failed = Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
    const client = fakeClient([{}, {}, failed]);
    const s = dynamoUsageStore(client, "t");
    await s.recordFirstLogin("anon1", sep);
    await s.recordFirstLogin("anon1", sep);
    expect(client.sent.map((x) => x.name)).toEqual(["PutCommand", "UpdateCommand", "PutCommand"]);
    expect(client.sent[0]!.input).toMatchObject({
      Item: { PK: "USER#anon1", SK: "PROFILE", firstSeen: "2026-09" },
      ConditionExpression: "attribute_not_exists(PK)",
    });
    expect(client.sent[1]!.input).toMatchObject({ Key: { PK: "GLOBAL", SK: "ALL" }, UpdateExpression: "ADD totalUsers :one" });
    expect(new PutCommand(client.sent[0]!.input as never)).toBeInstanceOf(PutCommand);
  });

  it("rethrows other errors from the profile put", async () => {
    const client = fakeClient([new Error("boom")]);
    await expect(dynamoUsageStore(client, "t").recordFirstLogin("anon1", sep)).rejects.toThrow("boom");
  });

  it("reads months newest first and maps tool attributes", async () => {
    const client = fakeClient([
      { Items: [{ PK: "USER#anon1", SK: "MONTH#2026-09", calls: 2, errors: 1, "tool#list_companies": 2 }] },
      { Items: [{ PK: "GLOBAL", SK: "MONTH#2026-09", calls: 5, errors: 1, activeUsers: 2, "tool#list_companies": 5 }] },
      { Item: { PK: "GLOBAL", SK: "ALL", totalUsers: 7 } },
    ]);
    const s = dynamoUsageStore(client, "t");
    expect(await s.userMonths("anon1")).toEqual([{ month: "2026-09", calls: 2, errors: 1, tools: { list_companies: 2 } }]);
    expect(await s.globalStats()).toEqual({ totalUsers: 7, months: [{ month: "2026-09", calls: 5, errors: 1, activeUsers: 2, tools: { list_companies: 5 } }] });
    expect(client.sent[0]!.input).toMatchObject({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)",
      ExpressionAttributeValues: { ":pk": "USER#anon1", ":m": "MONTH#" },
      ScanIndexForward: false,
      Limit: 24,
    });
    expect(new QueryCommand(client.sent[0]!.input as never)).toBeInstanceOf(QueryCommand);
    expect(new GetCommand(client.sent[2]!.input as never)).toBeInstanceOf(GetCommand);
  });
});
