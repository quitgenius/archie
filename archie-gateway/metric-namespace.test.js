'use strict';

// vitest globals enabled via vitest.config.js
const fs = require('node:fs');
const path = require('node:path');

// ── Why this file exists ────────────────────────────────────────────────────────────────────────
//
// The OpenClaw and archie gateways run side by side from the SAME IMAGE, and both emit fleet-wide
// dimensionless EMF aggregates. A shared metric namespace therefore sums two fleets into one series and
// every alarm on it is wrong in a way that looks plausible — so each stack takes its namespace from the
// environment (DISPATCHER_METRIC_NAMESPACE / CRON_METRIC_NAMESPACE), defaulting to the historical value.
//
// That conversion was done ONE FILE AT A TIME and a third emitter was missed: cron-inventory-metrics.js
// kept `const NAMESPACE = 'ClawdbotCron'`, so archie's own cron namespace stayed EMPTY while every cron
// inventory gauge landed in the OpenClaw namespace — and the cron alarms in modules/archie/alarms.tf
// silently matched nothing. Nothing failed; the metrics just went to the wrong place.
//
// So the invariant is enforced two ways below: behaviourally for the known emitters, and structurally
// across the directory so a FOURTH emitter cannot be added with a hardcoded literal.

const DIR = __dirname;

/** Non-test source files in this directory. */
const sourceFiles = () => fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && !f.endsWith('.config.js'));

describe('EMF namespaces are per-stack, not hardcoded', () => {
  it('every module that declares a metric NAMESPACE reads it from the environment', () => {
    // Structural, because the failure mode is "a new emitter file forgets", which no behavioural test
    // over the CURRENT emitters can catch.
    const offenders = [];
    for (const f of sourceFiles()) {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8');
      for (const m of src.matchAll(/^\s*const\s+NAMESPACE\s*=\s*(.+)$/gm)) {
        if (!m[1].includes('process.env')) offenders.push(`${f}: ${m[1].trim()}`);
      }
    }
    expect(offenders, `hardcoded metric namespace(s) — these publish into the OTHER stack's series: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no module builds an EMF line with a literal Clawdbot* namespace', () => {
    // Belt and braces: catches an emitter that inlines the namespace into the _aws block rather than
    // declaring a NAMESPACE constant at all.
    const offenders = [];
    for (const f of sourceFiles()) {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8');
      for (const m of src.matchAll(/Namespace:\s*'([^']+)'/g)) {
        if (m[1].startsWith('Clawdbot')) offenders.push(`${f}: Namespace: '${m[1]}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('EMF namespaces honour the override at runtime', () => {
  // NAMESPACE is read at MODULE LOAD, and vi.resetModules() does not clear Node's CJS require cache —
  // so an in-process env test silently measures whichever value loaded first. A subprocess is the only
  // way to actually exercise the load-time read, which is the thing that broke.
  const { execFileSync } = require('node:child_process');
  const namespacesUnder = (env) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const d = require('./dispatcher-metrics');
    const c = require('./cron-metrics');
    const i = require('./cron-inventory-metrics');
    process.stdout.write(JSON.stringify({
      dispatcher: d.DISPATCHER_METRIC_NAMESPACE,
      cron: c.CRON_METRIC_NAMESPACE,
      cronInventory: i.CRON_INVENTORY_NAMESPACE,
    }));
  `], { cwd: DIR, env: { ...process.env, ...env }, encoding: 'utf8' }));

  it('all three emitters follow the override', () => {
    const ns = namespacesUnder({
      DISPATCHER_METRIC_NAMESPACE: 'testStackDispatcher',
      CRON_METRIC_NAMESPACE: 'testStackCron',
    });
    expect(ns.dispatcher).toBe('testStackDispatcher');
    expect(ns.cron).toBe('testStackCron');
    // The one that was missed: it shares CRON_METRIC_NAMESPACE with cron-metrics rather than having its
    // own variable, so there is one knob per stack rather than one per file.
    expect(ns.cronInventory).toBe('testStackCron');
  });

  it('defaults to the historical namespaces so the OpenClaw stack does not move', () => {
    const ns = namespacesUnder({ DISPATCHER_METRIC_NAMESPACE: '', CRON_METRIC_NAMESPACE: '' });
    expect(ns.dispatcher).toBe('ClawdbotDispatcher');
    expect(ns.cron).toBe('ClawdbotCron');
    expect(ns.cronInventory).toBe('ClawdbotCron');
  });
});
