'use strict';

// Single source of truth for the READ-ONLY CloudWatch/Logs grant the OTEL self-debugging
// tools (otel-tool.mjs) need. The runtime exec role today is telemetry WRITE-only (logs:Put*,
// xray:Put*); the tools query it back via Logs Insights (StartQuery/GetQueryResults over
// aws/spans + the dispatcher log) and CloudWatch metrics (GetMetricData over the SEARCH
// specs in agentcore-observability/insight-queries.js). Requireable by both the BDD provisioner
// (provision.js execStatements) and the prod-role grant script (apply-observability-grant.mjs)
// so the two can never drift.
//
// Least-privilege: read verbs only. Resource '*' because Logs Insights StartQuery is authorized
// against log-group ARNs but the queries span aws/spans + the fleet dispatcher group + the
// per-agent runtime groups, and cloudwatch:GetMetricData is not resource-scopable. Mirrors the shape
// of infrastructure/lib/datadog + iam-read-insights read policies already in this repo.
//
// OPEN (the IAM half of the 2026-08-11 scoping work): '*' here is wider than the tools need — it
// admits EVERY log group in the account, including other services' logs. The tools only ever read
// three: `aws/spans`, the dispatcher group, and this agent's OWN runtime groups
// (/aws/bedrock-agentcore/runtimes/oc_<agent>*, resolved by prefix in otel-tool.mjs
// ownRuntimeLogGroups). When narrowing this, scope the two shared groups here and put the
// own-runtime prefix on the PER-AGENT derived role (it's the only role that knows the agent) —
// and note the hard limits: logs:GetQueryResults/StopQuery take a queryId, not a log group, so they
// must stay '*', and cloudwatch:GetMetricData/ListMetrics/GetMetricStatistics support no
// resource-level permissions or namespace condition at all. Own-scope for the SHARED stores is
// therefore enforced in the tool (the otel_my_* tier), not here — IAM cannot express it.
// LOCKSTEP: the same two statements live in modules/clawdbot/agentcore_derived_roles.tf.

// The statements, as an inline-policy statement array (each carries its own Sid).
function observabilityReadStatements() {
  return [
    {
      Sid: 'ObservabilityLogsRead',
      Effect: 'Allow',
      Action: [
        'logs:StartQuery',
        'logs:StopQuery',
        'logs:GetQueryResults',
        'logs:GetLogEvents',
        'logs:FilterLogEvents',
        'logs:GetLogGroupFields',
        'logs:DescribeQueries',
        'logs:DescribeLogGroups',
      ],
      Resource: '*',
    },
    {
      Sid: 'ObservabilityMetricsRead',
      Effect: 'Allow',
      Action: [
        'cloudwatch:GetMetricData',
        'cloudwatch:ListMetrics',
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:DescribeAlarms',
      ],
      Resource: '*',
    },
  ];
}

// A standalone inline policy document (for attaching as its OWN policy, e.g. onto the shared
// prod role whose main `agentcore-exec` policy is condition-pinned and must not be rewritten).
function observabilityReadPolicy() {
  return { Version: '2012-10-17', Statement: observabilityReadStatements() };
}

const OBSERVABILITY_POLICY_NAME = 'agentcore-observability-read';

module.exports = { observabilityReadStatements, observabilityReadPolicy, OBSERVABILITY_POLICY_NAME };
