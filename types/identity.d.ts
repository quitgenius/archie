// The two identity spaces an agent has, as DISTINCT types.
//
// WHY THIS FILE EXISTS. §8.10 moved every agent from its config-repo name to a scope id, and the two
// are both `string`, so nothing could tell them apart. Three separate outages came from a caller
// holding one and passing it where the other was meant:
//
//   eb14aeefa  hydration started writing ONLY the scope id. `cron hydrate` still looked up
//              `AGENT#<legacy>/META`, which now exists for no agent, so it refused every invocation
//              and demanded `--as` (fixed in 518562105). Connector adoption still resolved secrets
//              and projects by the agent's table id, which had moved, so every hydrated agent
//              silently ran on the SHARED project with nobody's connections (fixed in a2bfb6130).
//
//   the split  three cron jobs stored under `agent-xx9aff` while every Slack message routed
//   identity   to `dm-ux0mz5ckp2r` — jobs that ran, for an agent with no config, runtime or grants.
//
// Every one of those typechecks perfectly as `string`, passes unit tests against injected fakes, and
// fails only against real data. A brand is the cheapest thing that turns "sweep the callers" from
// something you have to remember into a list `tsc --noEmit` hands you.
//
// HOW BRANDS WORK HERE. The `__brand` property does not exist at runtime — these are still plain
// strings, there is no wrapper, no allocation and no behaviour change. It exists only so the
// compiler refuses to substitute one for the other. `String(x)`, template literals and JSON all
// behave exactly as before.
//
// THE BOUNDARIES ARE WHERE THE THINKING GOES. Anything from DynamoDB, `JSON.parse`, `process.env` or
// `argv` arrives as a bare `string` and must be cast deliberately — that cast is the moment to ask
// "which space is this?". Brands do not remove that judgement, they LOCALISE it to a handful of
// parse sites where it is visible, instead of leaving it implicit at every call site.

/**
 * A §8.10 scope identity — `dm-<userId>` or `ch-<channelId>`.
 *
 * THE agent identity everywhere in archie: the DynamoDB partition key, the routing GSI sort key, the
 * derived IAM role name, the Connector secret suffix, and the owner of a cron job. Produced by
 * exactly two functions, which are held in lockstep by a test: `scopeIdFor` (config-resolver/
 * rekey-to-scope.mjs) and `scopeIdForRouting` (slack-dispatcher/agent-scope.js). Nothing else may
 * mint one, because "the name IS the route, recomputed on every message" only holds if there is one
 * rule.
 */
export type ScopeId = string & { readonly __brand: 'ScopeId' };

/**
 * The pre-§8.10 config-repo name — `agent-xx9aff`, `agent-83l3pa`.
 *
 * A PATH ON EFS AND A KEY IN THE CONFIG REPO, never an identity in archie. It survives in exactly
 * one place, `META.efsRoot`, so a migrated agent can adopt ~270GB of existing workspace, sessions
 * and memory without copying it. `fleet drift` reads it to tell a legitimate legacy adopt from real
 * data loss; the dispatcher's `legacyAgentIdFor` reads it to know an agent is not new; `cron
 * hydrate` takes one as its argument because that is what the EFS directory is called.
 *
 * Storing anything under it produces an agent no Slack event resolves to.
 */
export type LegacyName = string & { readonly __brand: 'LegacyName' };
