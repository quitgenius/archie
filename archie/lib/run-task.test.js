'use strict';

// Tests for lib/run-task.js — the ephemeral-Fargate-task runner shared by `cron hydrate` and
// `agent teardown`'s cron purge.
//
// WHAT THIS IS FOR. The runner's whole value is that the task's OWN OUTPUT becomes the report: both
// callers print per-job counts they never compute themselves. So a log lookup that silently misses is
// not a cosmetic bug — it turns "the run worked and here is what it did" into "exit 0, no idea", and
// teardown then cannot tell an empty store from an unread one. The container name was hardcoded to
// `cron-hydrator`, which broke exactly that for the second task type on its first live run
// (2026-08-19). These tests pin the stream path to the definition being run.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runEphemeralTask } = require('./run-task');

const fakeOut = () => {
  const o = { progressLines: [], warnings: [] };
  o.progress = (m) => o.progressLines.push(String(m));
  o.warn = (m) => o.warnings.push(String(m));
  o.verbose = () => {};
  o.failure = () => {};
  return o;
};

const said = (lines, re) => lines.some((l) => re.test(l));

const tdFor = (containerName) => ({
  family: 'archie-dispatcher-cron-purge',
  containerDefinitions: [{ name: containerName, image: 'repo/img:tag' }],
});

/** An ECS fake that registers, runs, and reports one STOPPED task with the given exit code. */
const fakeEcs = ({ exitCode = 0 } = {}) => ({
  sent: [],
  async send(cmd) {
    const n = cmd.constructor.name;
    this.sent.push(n);
    if (n === 'RegisterTaskDefinitionCommand') {
      return { taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/archie-dispatcher-cron-purge:12' } };
    }
    if (n === 'RunTaskCommand') {
      return { tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:1:task/archie/abc123' }], failures: [] };
    }
    if (n === 'DescribeTasksCommand') {
      return { tasks: [{ lastStatus: 'STOPPED', stoppedReason: 'Essential container in task exited', containers: [{ exitCode }] }] };
    }
    if (n === 'DeregisterTaskDefinitionCommand') return {};
    throw new Error(`unexpected ECS command ${n}`);
  },
});

/** A CloudWatch Logs fake that only answers for ONE exact stream name. */
const fakeLogs = (expectedStream, events = ['{"msg":"hello"}']) => ({
  asked: [],
  async send(cmd) {
    this.asked.push(cmd.input.logStreamName);
    if (cmd.input.logStreamName !== expectedStream) {
      const err = new Error('The specified log stream does not exist.');
      err.name = 'ResourceNotFoundException';
      throw err;
    }
    return { events: events.map((message) => ({ message })) };
  },
});

const run = (over = {}) => runEphemeralTask({
  cluster: 'archie',
  subnets: ['subnet-1'],
  securityGroups: ['sg-1'],
  logGroup: '/ecs/archie-dispatcher',
  streamPrefix: 'cron-purge',
  out: over.out || fakeOut(),
  sleep: async () => {},
  ...over,
});

test('the log stream path uses the CONTAINER NAME from the definition, not a constant', async () => {
  // The regression: hardcoding 'cron-hydrator' made a cron-purge task look output-less.
  const logs = fakeLogs('cron-purge/cron-purge/abc123', ['{"purged":{"removed":2}}']);
  const r = await run({ ecs: fakeEcs(), logs, taskDefinition: tdFor('cron-purge') });
  assert.deepEqual(logs.asked, ['cron-purge/cron-purge/abc123']);
  assert.deepEqual(r.logLines, ['{"purged":{"removed":2}}']);
});

test('the hydrator path is unchanged — same prefix and container as before', async () => {
  const logs = fakeLogs('cron-hydrator/cron-hydrator/abc123', ['{"posted":2}']);
  const r = await run({
    ecs: fakeEcs(), logs, streamPrefix: 'cron-hydrator', taskDefinition: tdFor('cron-hydrator'),
  });
  assert.deepEqual(r.logLines, ['{"posted":2}']);
});

test('a definition with no container name WARNS rather than guessing a stream', async () => {
  // Guessing produces "the task wrote nothing", which is the false negative the parameter removes.
  const out = fakeOut();
  const logs = fakeLogs('never/asked/for');
  const r = await run({ ecs: fakeEcs(), logs, out, taskDefinition: { family: 'f', containerDefinitions: [{}] } });
  assert.deepEqual(logs.asked, []);
  assert.deepEqual(r.logLines, []);
  assert.ok(said(out.warnings, /declared no container name/));
});

test('a missing stream is reported, not fatal — the exit code already carries the verdict', async () => {
  const out = fakeOut();
  const r = await run({ ecs: fakeEcs(), logs: fakeLogs('some/other/stream'), out, taskDefinition: tdFor('cron-purge') });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.logLines, []);
  assert.ok(said(out.warnings, /ResourceNotFoundException/));
});

test('the ephemeral definition is deregistered even when the task fails', async () => {
  const ecs = fakeEcs({ exitCode: 1 });
  await assert.rejects(
    () => run({ ecs, logs: fakeLogs('cron-purge/cron-purge/abc123'), taskDefinition: tdFor('cron-purge') }),
    /exited 1/,
  );
  assert.ok(ecs.sent.includes('DeregisterTaskDefinitionCommand'), 'a leaked definition accumulates revisions forever');
});
