'use strict';

// Run a one-off Fargate task from an EPHEMERAL task definition: register, RunTask, wait, report,
// deregister. GATEWAY-OWNERSHIP-PLAN.md §8.
//
// WHY EPHEMERAL AT ALL. The cron hydrator used to be a standing Terraform task definition. It holds a
// privilege the always-on gateway deliberately refuses — a mount rooted at the PARENT <prefix>/agents,
// so one task can read every agent's subtree — and it is a cutover tool with a finite life. Holding
// that capability for the life of one task, rather than permanently, is the point. Terraform still
// owns the access point, because the access point IS the privilege; this only decides when a task may
// use it.
//
// THE DEREGISTER IS IN A `finally`, AND THAT MATTERS. A failure between RunTask and the wait would
// otherwise leave the definition behind — which is exactly the standing resource this design removed,
// re-created by accident and now unowned by Terraform. Deregistration is also why the family can be
// reused: ECS keeps deregistered revisions addressable but inactive, so nothing accumulates that a
// later `DescribeTaskDefinition <family>` would resolve to.
//
// EXIT CODE IS THE RESULT. A task that runs and exits non-zero is a FAILURE, not a completed run —
// the container's own logs carry the reason, and the caller gets both.

const { CliError, timeout: timeoutError } = require('./exit');

const POLL_INTERVAL_MS = 3000;
const DEFAULT_BUDGET_SECONDS = 600;

/**
 * @param opts.ecs             ECS client
 * @param opts.logs            CloudWatchLogs client (optional; without it, no log tail)
 * @param opts.taskDefinition  a RegisterTaskDefinition input
 * @param opts.cluster
 * @param opts.subnets         set-valued, from the file system's mount targets
 * @param opts.securityGroups
 * @param opts.logGroup        where the container logs (for the tail)
 * @param opts.streamPrefix    awslogs-stream-prefix, to locate the stream
 * @param opts.out             CLI output
 * @param opts.budgetMs
 */
async function runEphemeralTask(opts) {
  const {
    ecs, logs, taskDefinition, cluster, subnets, securityGroups,
    logGroup, streamPrefix, out, now = Date.now, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
    budgetMs = DEFAULT_BUDGET_SECONDS * 1000, pollIntervalMs = POLL_INTERVAL_MS,
  } = opts;
  const {
    RegisterTaskDefinitionCommand, DeregisterTaskDefinitionCommand, RunTaskCommand, DescribeTasksCommand,
  } = require('@aws-sdk/client-ecs');

  let registeredArn = null;
  try {
    const registered = await ecs.send(new RegisterTaskDefinitionCommand(taskDefinition));
    registeredArn = registered.taskDefinition.taskDefinitionArn;
    out.progress(`registered  ${arnTail(registeredArn)}  (ephemeral — deregistered when this exits)`);

    const run = await ecs.send(new RunTaskCommand({
      cluster,
      taskDefinition: registeredArn,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: { subnets, securityGroups, assignPublicIp: 'DISABLED' },
      },
    }));

    // A REFUSED RunTask IS REPORTED HERE, not left as an empty task list. `failures` is how ECS says
    // "no capacity", "subnet has no route", "image pull will fail" — surfacing it as "the task did
    // not appear" would send someone looking in the wrong place entirely.
    const failures = run.failures || [];
    if (failures.length || !(run.tasks || []).length) {
      throw new CliError('ecs:RunTask started no task', {
        detail: failures.map((f) => `${f.arn || 'task'}: ${f.reason}${f.detail ? ` (${f.detail})` : ''}`).join('; ')
          || 'no tasks and no failures returned',
      });
    }

    const taskArn = run.tasks[0].taskArn;
    out.progress(`running     ${arnTail(taskArn)} on ${cluster}  subnets=${subnets.join(',')}`);

    const finished = await waitForStop({
      ecs, cluster, taskArn, out, now, sleep, budgetMs, pollIntervalMs,
    });

    const container = (finished.containers || [])[0] || {};
    const exitCode = container.exitCode;
    // The CONTAINER NAME is part of the stream path, so it comes from the definition being run rather
    // than a constant. It was hardcoded to 'cron-hydrator', which meant the second kind of ephemeral
    // task (`cron-purge`, teardown) looked up a stream that does not exist and silently reported no
    // output — the run had worked, and the CLI said it could not tell.
    const containerName = ((taskDefinition.containerDefinitions || [])[0] || {}).name;
    const tail = logs ? await tailLogs({ logs, logGroup, streamPrefix, containerName, taskArn, out }) : [];

    if (exitCode !== 0) {
      throw new CliError(`the task exited ${exitCode === undefined ? 'without an exit code' : exitCode}`, {
        detail: [container.reason, finished.stoppedReason, ...tail.slice(-12)].filter(Boolean).join('\n'),
      });
    }

    return {
      taskArn, exitCode, stoppedReason: finished.stoppedReason || null, logLines: tail,
      taskDefinition: arnTail(registeredArn),
    };
  } finally {
    if (registeredArn) {
      try {
        await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: registeredArn }));
        out.verbose(`deregistered ${arnTail(registeredArn)}`);
      } catch (err) {
        // Reported, never thrown: it would replace a real failure with a cleanup one, and the
        // leftover is inert (a deregistered-or-not definition runs nothing on its own).
        out.warn(`could not deregister ${arnTail(registeredArn)}: ${err && err.message} — it is inert, `
          + 'but `aws ecs deregister-task-definition` will tidy it');
      }
    }
  }
}

/** Poll to STOPPED. A one-off task has no steady state to wait for, so this is the only signal. */
async function waitForStop({ ecs, cluster, taskArn, out, now, sleep, budgetMs, pollIntervalMs }) {
  const { DescribeTasksCommand } = require('@aws-sdk/client-ecs');
  const startedAt = now();
  let lastStatus = null;

  for (;;) {
    if (now() - startedAt > budgetMs) {
      throw timeoutError(`budget of ${Math.round(budgetMs / 1000)}s expired waiting for ${arnTail(taskArn)} to stop`, {
        detail: `Last status: ${lastStatus || 'unknown'}. The task may still be running — check with `
          + `\`aws ecs describe-tasks --cluster ${cluster} --tasks ${arnTail(taskArn)}\` before re-running.`,
      });
    }
    const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
    const task = (described.tasks || [])[0];
    if (task) {
      if (task.lastStatus !== lastStatus) {
        lastStatus = task.lastStatus;
        out.progress(`task        ${lastStatus}`);
      }
      if (task.lastStatus === 'STOPPED') return task;
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * The container's own output, which is the actual result of a hydration run.
 *
 * The stream name is `<prefix>/<container>/<taskId>` — ECS's convention, not a guess, but derived
 * rather than looked up because ListLogStreams on a busy group is a paged scan for one known name.
 */
async function tailLogs({ logs, logGroup, streamPrefix, containerName, taskArn, out }) {
  if (!logGroup) return [];
  const { GetLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
  const taskId = arnTail(taskArn);
  if (!containerName) {
    // Refusing to guess: a wrong container name reads as "the task wrote nothing", which is the exact
    // false negative this parameter exists to remove.
    out.warn(`cannot locate the log stream for ${arnTail(taskArn)} — the task definition declared no `
      + 'container name, so the task\'s own output is not included below');
    return [];
  }
  const streamName = `${streamPrefix}/${containerName}/${taskId}`;
  try {
    const res = await logs.send(new GetLogEventsCommand({
      logGroupName: logGroup, logStreamName: streamName, startFromHead: true, limit: 300,
    }));
    return (res.events || []).map((e) => e.message.trimEnd());
  } catch (err) {
    // A missing stream means the container never wrote anything — worth saying, not worth failing
    // over, because the exit code already carries the verdict.
    out.warn(`could not read ${logGroup}:${streamName} (${err && err.name}) — the task's own output is `
      + 'not included below');
    return [];
  }
}

const arnTail = (arn) => String(arn || '').split('/').pop();

module.exports = { runEphemeralTask, DEFAULT_BUDGET_SECONDS };
