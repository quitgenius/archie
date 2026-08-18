// The `PolicyDenyAll` metric and the alarm that consumes it, enforced STRUCTURALLY.
//
// WHY NOT A BEHAVIOURAL TEST. `pi-adapter.mjs` cannot be imported in a unit test — it reads the
// environment and touches EFS/DynamoDB at module scope — so `loadPolicy()` is not directly callable
// here. The invariant is still worth pinning, because what makes an alarm useless is not usually a
// broken emitter: it is an emitter that exists on one code path and not the others, which no green test
// suite notices.
//
// THE FAILURE THIS PREVENTS, concretely. `loadPolicy()` has TWO exits that produce a deny-all table:
// the DynamoDB read throwing (`read-failed`, an early return inside the catch) and the tail of the
// function (absent row, or any validation refusal). The first version of this metric was emitted only at
// the tail — so the alarm would have stayed in OK through a DynamoDB outage, which is the single
// incident it most exists to catch. Both paths are asserted below.
//
// The second half checks the Terraform alarm actually references the metric. An EMF metric with no
// alarm is a dashboard widget, and an alarm naming a metric nobody emits sits in INSUFFICIENT_DATA
// looking healthy — the exact failure mode metric-namespace.test.js was written for, where cron alarms
// silently matched nothing for weeks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const adapter = fs.readFileSync(path.join(HERE, 'pi-adapter.mjs'), 'utf8');
// ../../.. from agentcore-pi: archie-runner -> docker -> infrastructure, where modules/ lives.
// GOT THIS WRONG FIRST (one '..' short), and the test SKIPPED rather than failed — which is precisely the
// shape of failure this file exists to catch, so the path is asserted rather than trusted below.
const ALARMS = path.join(HERE, '..', '..', '..', 'modules', 'archie', 'alarms.tf');

const METRIC = 'PolicyDenyAll';

test('the metric is declared as EMF in the AgentCore/Pi namespace', () => {
  // Namespace matters as much as the name: the alarm in alarms.tf is pinned to AgentCore/Pi, and EMF
  // sent to any other namespace lands somewhere nothing is watching.
  assert.match(adapter, new RegExp(`Namespace: 'AgentCore/Pi'[^\\n]*${METRIC}`),
    `${METRIC} must be emitted as EMF in the AgentCore/Pi namespace`);
});

test('BOTH deny-all exits emit it — including the DynamoDB-outage early return', () => {
  // The emitter is called once at the tail and once inside the catch. Two call sites, and the count is
  // asserted rather than mere presence: a refactor that collapses them into one is exactly how the
  // read-failed path loses its emission again.
  const calls = adapter.match(/emitPolicyDenyAll\(/g) || [];
  const declaration = 1; // `function emitPolicyDenyAll(` also matches the bare name, so exclude it
  assert.ok(calls.length - declaration >= 2,
    `expected >= 2 emitPolicyDenyAll call sites (tail + read-failed catch), found ${calls.length - declaration}`);

  // And specifically that the catch block has one: locating it by the reason it reports, so the
  // assertion survives the block moving.
  const readFailed = adapter.slice(adapter.indexOf("onProblem('read-failed'"));
  const untilReturn = readFailed.slice(0, readFailed.indexOf('return failed;') + 20);
  assert.match(untilReturn, /emitPolicyDenyAll\(/,
    'the read-failed early return must emit before returning — an alarm wired only at the tail would '
    + 'stay in OK through a DynamoDB outage');
});

test('it emits 0 on the healthy path, not just 1 on failure', () => {
  // A metric that only appears on failure leaves the alarm nothing to sit on between incidents, so
  // "healthy" and "this image does not emit the metric" become indistinguishable and the alarm depends
  // on treat_missing_data to tell them apart — which it cannot.
  assert.match(adapter, new RegExp(`${METRIC}: denied \\? 1 : 0`),
    `${METRIC} must be emitted on both outcomes`);
});

test('telemetry cannot change the verdict', () => {
  // Same rule as emitBootFailed: the emitter is wrapped so a failed EMF write never replaces the real
  // policy state with an error about metrics.
  const fn = adapter.slice(adapter.indexOf('function emitPolicyDenyAll'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /try \{/);
  assert.match(body, /catch \{/);
});

test('an alarm in Terraform actually consumes the metric', () => {
  // NOT skippable-on-missing-file. A skip here is indistinguishable from a pass in the summary line, and
  // the thing under test is whether an alarm exists at all — so a wrong path must FAIL.
  assert.ok(fs.existsSync(ALARMS), `alarms.tf not found at ${ALARMS} — fix the path, do not skip`);
  const tf = fs.readFileSync(ALARMS, 'utf8');
  assert.match(tf, new RegExp(`metric_name\\s*=\\s*"${METRIC}"`), `no alarm references ${METRIC}`);
  // The alarm block, isolated, so these assertions cannot be satisfied by a different alarm nearby.
  const start = tf.indexOf('"policy_deny_all"');
  assert.ok(start > 0, 'the policy_deny_all alarm resource must exist');
  const block = tf.slice(start, tf.indexOf('\n}\n', start));
  assert.match(block, /namespace\s*=\s*"AgentCore\/Pi"/, 'must watch the namespace the runtime emits to');
  assert.match(block, /statistic\s*=\s*"Sum"/, 'Sum: any single deny-all turn is a breach');
  assert.match(block, /threshold\s*=\s*0/);
  assert.match(block, /comparison_operator\s*=\s*"GreaterThanThreshold"/);
  // notBreaching, NOT breaching: a mostly-idle fleet emits nothing during quiet periods, and "no turns
  // at all" is dispatcher_not_running's signal rather than this one's.
  assert.match(block, /treat_missing_data\s*=\s*"notBreaching"/);
  assert.match(block, /alarm_actions\s*=\s*var\.alarm_actions/);
});
