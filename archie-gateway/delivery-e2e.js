'use strict';

// Live cron-delivery E2E (pi-cron-migration-plan.md §7 / Phase 4 P4). Runs as a one-off
// in-VPC Fargate task on the dispatcher image (has @slack/web-api + cron-delivery.js).
// Exercises the REAL delivery code against REAL Slack (announce) and a REAL HTTP POST
// plus the none / NO_REPLY no-op paths, and asserts webhook is REJECTED (mode removed). The
// announce test posts to the operator's DM and then DELETES the message, so it leaves no
// trace. No agentcore turn / agent-xx9aff flip needed — this isolates the delivery layer
// (the fire→deliver wiring is unit-tested and exercised by the P2/9c live runs).
//
// Env: SLACK_BOT_TOKEN (required); DELIVERY_TEST_SLACK_USER (default = sandbox).

const { WebClient } = require('@slack/web-api');
const { createDeliver } = require('./cron-delivery');

const checks = [];
const check = (n, ok, d) => { checks.push({ n, ok: !!ok }); console.log(ok ? 'PASS ' : 'FAIL ', n, d !== undefined ? JSON.stringify(d) : ''); };
const log = {
  info: (o, m) => console.log('INFO ', m, JSON.stringify(o)),
  warn: (o, m) => console.warn('WARN ', m, JSON.stringify(o)),
  error: (o, m) => console.error('ERROR', m, JSON.stringify(o)),
};

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('delivery-e2e: SLACK_BOT_TOKEN required');
  const user = process.env.DELIVERY_TEST_SLACK_USER || 'UX0MZ5CKP2R';
  const nonce = `P4-${Date.now()}`;
  const slack = new WebClient(token);
  const deliver = createDeliver({ slack, log }).deliver;

  // ── announce → real Slack (post to the operator's DM, verify, then delete) ──────
  const dm = await slack.conversations.open({ users: user });
  const channel = dm.channel.id;
  const aRes = await deliver(
    { jobId: 'p4-announce', agentId: 'p4-test', delivery: { mode: 'announce', channel } },
    { text: `${nonce}-ANNOUNCE (cron delivery test — safe to ignore)` },
  );
  check('announce delivered', aRes.delivered === true, aRes);
  const hist = await slack.conversations.history({ channel, limit: 5 });
  const posted = (hist.messages || []).find((m) => m.text && m.text.includes(`${nonce}-ANNOUNCE`));
  check('announce message present in Slack', !!posted, posted && { ts: posted.ts });
  if (posted) {
    try { await slack.chat.delete({ channel, ts: posted.ts }); check('announce test message deleted (no trace)', true); }
    catch (e) { check('announce test message deleted (no trace)', false, String(e && e.message)); }
  }

  // ── webhook → REMOVED (unvalidated egress; 0 of 356 prod jobs used it) ──────────
  const wRes = await deliver(
    { jobId: 'p4-webhook', agentId: 'p4-test', delivery: { mode: 'webhook', to: 'http://127.0.0.1:1/hook' } },
    { text: `${nonce}-WEBHOOK` },
  );
  check('webhook mode is rejected, nothing sent', wRes.delivered === false && /unknown delivery mode/.test(wRes.error || ''), wRes);

  // ── none → no-op ────────────────────────────────────────────────────────────────
  const nRes = await deliver({ jobId: 'p4-none', agentId: 'p4-test', delivery: { mode: 'none' } }, { text: 'should not post' });
  check('none is a no-op', nRes.delivered === false && nRes.reason === 'none', nRes);

  // ── NO_REPLY → announce skipped (no empty post) ─────────────────────────────────
  const nrRes = await deliver({ jobId: 'p4-nr', agentId: 'p4-test', delivery: { mode: 'announce', channel } }, { text: 'NO_REPLY' });
  check('NO_REPLY skips announce (no empty post)', nrRes.delivered === false && nrRes.reason === 'no-reply', nrRes);

  const failed = checks.filter((c) => !c.ok);
  console.log(`=== RESULT: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  if (failed.length) { console.error('FAILED:', failed.map((c) => c.n)); process.exitCode = 1; }
}

main().catch((err) => { console.error('delivery-e2e FATAL', err && err.stack || err); process.exit(1); });
