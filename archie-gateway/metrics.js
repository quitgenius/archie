// Lightweight DynamoDB message counter.
//
// On every routed Slack message the dispatcher calls recordMessage().
// The write is fire-and-forget — failures are logged but never block
// message delivery. If METRICS_TABLE_NAME is empty the function no-ops
// so existing deployments are unaffected.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.METRICS_TABLE_NAME || '';
let docClient = null;

function recordMessage(slackUserId, agentName, log) {
  if (!TABLE_NAME) return;
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const sk = `${slackUserId}#${agentName}`;
  const ttl = Math.floor(now.getTime() / 1000) + 90 * 86400;

  if (!docClient) docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { date, sk },
    UpdateExpression: 'SET #ttl = :ttl ADD message_count :one',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':ttl': ttl, ':one': 1 },
  })).catch(err => log.warn({ err: err.message, date, sk }, 'metrics write failed'));
}

module.exports = { recordMessage };
