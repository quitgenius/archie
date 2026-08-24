'use strict';

// "Is this efsRoot difference a §8.10 legacy adopt, or is it drift?" — ONE implementation.
//
// This rule was written three times independently, in cmd/stage.js, cmd/fleet.js and (missing, which
// is the bug that prompted hoisting it) cmd/generation.js's `verify`. Three copies of a predicate
// that decides whether to report fleet-wide drift is three chances to disagree, and the copies were
// already diverging: two of them consulted `AGENT#<id>/META` while the binding row had carried the
// answer since cmd/stage.js started writing `legacyEfsRoot`.
//
// THE SITUATION IT DESCRIBES. `derivedSpecFor` always derives `efsRootDir(agent, prefix)`, so an
// agent rekeyed under §8.10 — which legitimately ADOPTS its old directory rather than moving data —
// has an observed `efsRoot` that will never equal the derived one. Without this check every rekeyed
// agent reports an `efsRoot` mismatch forever: `verify` exits 7 for the whole fleet and `status`
// shows drift that is not there.
//
// THE DIRECTION THAT MATTERS. An UNPROVEN difference stays drift. An unreadable META, an absent
// binding field, a mismatch that does not look like an adopt — all of them keep the finding, because
// the failure this guards is data loss (an agent booting on an empty workspace) and silence in that
// direction is the expensive one.

/**
 * Does `root` look like the adopted legacy directory `<prefix>/<legacyName>`?
 *
 * Deliberately a suffix test rather than equality: the two sides carry different prefixes, which is
 * the whole reason they differ. Same predicate cmd/fleet.js applies to `fleet drift`.
 */
const looksAdopted = (root, legacy) => Boolean(root && legacy && String(root).endsWith(`/${legacy}`));

/**
 * The agent's legacy EFS root, from the item the dispatcher itself reads
 * (`agentcore-client.js:621-630` consults exactly this to decide an agent's access-point root).
 *
 * THE BLIND SPOT THIS CLOSES. A §8.10-rekeyed agent (`dm-u01…`) carries `AGENT#<id>/META.efsRoot` =
 * its FORMER name, and the provisioning saga mounts THAT directory so the rekeyed agent keeps its
 * workspace, memory and sessions. Derivation cannot know that — `derivedSpecFor` always derives
 * `efsRootDir(agent, prefix)` — so a comparison reports a phantom `efsRoot` change for every rekeyed
 * agent, and `fleet drift` BLOCKS on efsRoot changes. Left unhandled it would turn the loudest
 * refusal in the CLI into a false alarm operators learn to route around, which is worse than not
 * having it.
 *
 * Best effort BY CONSTRUCTION, and the direction of the failure is the point: an unreadable META
 * means we cannot PROVE the difference is a legacy adopt, and an unproven `efsRoot` difference stays
 * data loss and stays blocking.
 *
 * ONE IMPLEMENTATION, and now actually one. There were THREE byte-identical copies — here,
 * cmd/fleet.js and cmd/stage.js — while THIS file's header claimed to be the only one. fleet.js gave
 * it away: it already imported `adoptedRootFor` from here, and `adoptedRootFor` calls this, so it ran
 * both copies in the same call graph. Three copies of the function that decides "legacy adopt, or
 * data loss?" is three chances for that answer to diverge, visible only as a false block or a missed
 * one.
 */
async function legacyEfsRootOf(aws, ctx, agent) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  try {
    const r = await aws.doc().send(new GetCommand({
      TableName: ctx.resources.configTable,
      Key: { pk: `AGENT#${agent}`, sk: 'META' },
    }));
    if (!r.Item || !r.Item.data) return null;
    const meta = JSON.parse(r.Item.data);
    return meta && typeof meta.efsRoot === 'string' && meta.efsRoot ? meta.efsRoot : null;
  } catch {
    return null;
  }
}

/**
 * Is this `efsRoot` difference an adopt?
 *
 * Reads the BINDING first and only falls back to the `META` GetItem when it has nothing to say.
 * `cmd/stage.js` records `legacyEfsRoot` on the binding at the moment it proves the adopt, so the
 * answer is usually already in the row that is being verified — checking it first turns a per-agent
 * DynamoDB round trip into a field read across a 208-agent fleet.
 *
 * @param binding  the `RUNTIME#<agent>` row, which may carry `legacyEfsRoot`
 * @param roots    the two sides of the difference, in either order
 * @returns {Promise<string|null>} the legacy root that explains it, or null if nothing does
 */
async function adoptedRootFor(aws, ctx, agent, binding, roots = []) {
  const candidates = [binding && binding.legacyEfsRoot].filter(Boolean);
  if (!candidates.length) {
    const fromMeta = await legacyEfsRootOf(aws, ctx, agent);
    if (fromMeta) candidates.push(fromMeta);
  }
  for (const legacy of candidates) {
    // Either side may be the adopted one depending on which way the comparison runs.
    if (roots.some((r) => looksAdopted(r, legacy)) || roots.includes(legacy)) return legacy;
  }
  return null;
}

module.exports = { looksAdopted, legacyEfsRootOf, adoptedRootFor };
