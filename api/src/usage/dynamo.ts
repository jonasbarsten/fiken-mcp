import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { monthKey, type MonthRow, type UsageStore } from "./store.js";

export interface DynamoLike {
  send(command: unknown): Promise<unknown>;
}

function toMonthRow(item: Record<string, unknown>): MonthRow {
  const tools: Record<string, number> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k.startsWith("tool#")) tools[k.slice("tool#".length)] = v as number;
  }
  const month = (item.SK as string).slice("MONTH#".length);
  const row: MonthRow = {
    month,
    calls: (item.calls as number) ?? 0,
    errors: (item.errors as number) ?? 0,
    tools,
  };
  if (item.activeUsers !== undefined) row.activeUsers = item.activeUsers as number;
  return row;
}

function addUpdateInput(
  table: string,
  pk: string,
  sk: string,
  tool: string,
  err: 0 | 1,
  includeActiveUsers: boolean,
) {
  return {
    TableName: table,
    Key: { PK: pk, SK: sk },
    UpdateExpression: includeActiveUsers
      ? "ADD calls :one, errors :err, #t :one, activeUsers :one"
      : "ADD calls :one, errors :err, #t :one",
    ExpressionAttributeNames: { "#t": `tool#${tool}` },
    ExpressionAttributeValues: { ":one": 1, ":err": err },
  };
}

export function dynamoUsageStore(client: DynamoLike, table: string): UsageStore {
  return {
    async recordCall(anonId, tool, ok, now = new Date()) {
      const sk = monthKey(now);
      const err: 0 | 1 = ok ? 0 : 1;
      const userResult = (await client.send(
        new UpdateCommand({
          ...addUpdateInput(table, `USER#${anonId}`, sk, tool, err, false),
          ReturnValues: "ALL_OLD",
        }),
      )) as { Attributes?: Record<string, unknown> };
      const isFirstThisMonth = !userResult?.Attributes;
      await client.send(new UpdateCommand(addUpdateInput(table, "GLOBAL", sk, tool, err, isFirstThisMonth)));
    },

    async recordFirstLogin(anonId, now = new Date()) {
      const firstSeen = now.toISOString().slice(0, 7);
      try {
        await client.send(
          new PutCommand({
            TableName: table,
            Item: { PK: `USER#${anonId}`, SK: "PROFILE", firstSeen },
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === "ConditionalCheckFailedException") return;
        throw err;
      }
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: "GLOBAL", SK: "ALL" },
          UpdateExpression: "ADD totalUsers :one",
          ExpressionAttributeValues: { ":one": 1 },
        }),
      );
    },

    async userMonths(anonId) {
      const result = (await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)",
          ExpressionAttributeValues: { ":pk": `USER#${anonId}`, ":m": "MONTH#" },
          ScanIndexForward: false,
          Limit: 24,
        }),
      )) as { Items?: Array<Record<string, unknown>> };
      return (result.Items ?? []).map(toMonthRow);
    },

    async globalStats() {
      const monthsResult = (await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)",
          ExpressionAttributeValues: { ":pk": "GLOBAL", ":m": "MONTH#" },
          ScanIndexForward: false,
          Limit: 24,
        }),
      )) as { Items?: Array<Record<string, unknown>> };
      const allResult = (await client.send(
        new GetCommand({
          TableName: table,
          Key: { PK: "GLOBAL", SK: "ALL" },
        }),
      )) as { Item?: Record<string, unknown> };
      return {
        totalUsers: (allResult.Item?.totalUsers as number) ?? 0,
        months: (monthsResult.Items ?? []).map(toMonthRow),
      };
    },
  };
}
