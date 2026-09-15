// The runtime's read of the forwarder Lambda's drop-box.
//
// Resolved through `createRequire` against the image's config-resolver rather than imported, for
// two reasons. It keeps the AWS SDK out of this plugin's esbuild bundle (the Dockerfile builds it
// with no externals, so a bare import would inline the whole client). And it reuses the copy the
// image already ships — the same call pi-entrypoint makes, and for the same stated reason: "rather
// than adding a second copy of the DynamoDB client to this image".
//
// READ ONLY. The runtime holds no write on this table by design (agentcore-base-policy.cjs), so
// there is deliberately no put/delete here. Collected rows expire by TTL.

import { createRequire } from "node:module";
import { join } from "node:path";

export type CallbackQuery = (partitionKey: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Build the query used to collect landed OAuth2 callbacks, or null when this runtime has no config
 * table wired — which is every OpenClaw/ECS deployment, where the callback is forwarded to a live
 * container instead and nothing needs collecting.
 */
export function makeCallbackQuery(env: NodeJS.ProcessEnv = process.env): CallbackQuery | null {
  const table = env.AGENT_CONFIG_TABLE;
  if (!table) return null;

  const dir = env.CONFIG_RESOLVER_DIR || "/app/config-resolver";
  type Doc = { send: (cmd: unknown) => Promise<{ Items?: Array<Record<string, unknown>> }> };
  let doc: Doc | undefined;
  let QueryCommand: new (input: unknown) => unknown;

  // Resolved on first use, then reused: a cold turn pays the require once, and a runtime that
  // never has a pending flow never loads the SDK at all.
  const connect = (): Doc => {
    if (doc) return doc;
    const req = createRequire(join(dir, "package.json"));
    const { DynamoDBClient } = req("@aws-sdk/client-dynamodb");
    const lib = req("@aws-sdk/lib-dynamodb");
    QueryCommand = lib.QueryCommand;
    // DocumentClient so rows come back as plain values; the Lambda writes raw attribute values
    // with the low-level client and this unmarshalls them.
    doc = lib.DynamoDBDocumentClient.from(
      new DynamoDBClient(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
    ) as Doc;
    return doc;
  };

  return async (partitionKey: string) => {
    const client = connect();
    const r = await client.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": partitionKey },
    }));
    return r.Items ?? [];
  };
}
