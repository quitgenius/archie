// Pi extension: enforce tool-permission capabilities at the tool_call hook (the PEP choke point
// for every callable tool — built-in, custom, connector, MCP). Hindsight is NOT a tool, so it is
// gated separately at its own context/agent_end hooks via the `can()` helper below.

/**
 * @param capabilityOf (toolName) => capability   (from makeCapabilityResolver)
 * @param decide       (capability, ctx) => bool  (from makeDecider — also emits the OTEL signal)
 * @param turnCtx      the per-turn ctx (reads channel/agent; refreshed per invocation)
 */
/**
 * Destructive cron mutations an agent must not perform DURING a scheduled run.
 *
 * A cron job holds one session across fires (buildCronSessionKey — deliberate upstream parity), so
 * the agent reads its own past runs and can mistake its schedule for a fault. Live 2026-08-12:
 * `hiccup-ping` (every 2m) concluded "this is firing repeatedly — there's a runaway cron job",
 * called cron.remove, and DELETED ITSELF mid-turn — the removal is logged three seconds before the
 * turn that issued it completed. Both stores lost the schedule, and the mirror reconcile then
 * correctly propagated the deletion. Nothing was faulty; the failure was in the composition.
 *
 * cron-fire tells the agent it is inside a scheduled run, which addresses the misreading. This is
 * the guard for when that is not enough: a cron turn is UNATTENDED, so a wrong call has nobody to
 * catch it. Interactive turns are untouched — a human can still ask an agent to delete a job, and
 * sees the result.
 *
 * Not capability-shaped on purpose: the capability answers "may this agent use cron", which it may.
 * This answers "may it do so with no one watching", which is a property of the TRIGGER.
 */
function deniedCronMutation(event) {
  if (!event || event.toolName !== 'cron') return null;
  const input = event.input || event.args || {};
  const action = String(input.action || '');
  if (action === 'remove') return 'remove';
  // A disabling update is the same loss by another name.
  if (action === 'update' && input.patch && input.patch.enabled === false) return 'disable';
  return null;
}

export function createPermissionsExtension({ capabilityOf, decide, turnCtx }) {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (turnCtx.trigger === 'cron') {
        const kind = deniedCronMutation(event);
        if (kind) {
          return {
            block: true,
            reason: `permission denied: a scheduled run cannot ${kind} a cron job. `
              + 'The repeated output you can see in this session is this job\'s own schedule, not a '
              + 'runaway. If the job genuinely needs changing, say so in your reply and a human will '
              + 'action it in a normal conversation.',
          };
        }
      }
      const cap = capabilityOf(event.toolName);
      const allowed = decide(cap, { tool: event.toolName, channel: turnCtx.channel, agent: turnCtx.agent, trigger: turnCtx.trigger });
      if (!allowed) {
        // Blocking reason is fed back to the model as the tool result — legible + seeds a grant request.
        return { block: true, reason: `permission denied: capability "${cap}" is not granted in this channel` };
      }
      // allowed → undefined lets the call proceed unchanged
    });
  };
}

// Fixed-capability gate for the hindsight hooks (read = context injection, write = agent_end retain).
// Hindsight isn't a tool, so it can't ride the tool_call hook — it calls can('hindsight.read'|'write').
export function makeCan(decide, turnCtx) {
  return (capability) => decide(capability, { surface: 'hindsight', channel: turnCtx.channel, agent: turnCtx.agent });
}
