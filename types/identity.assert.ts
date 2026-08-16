// THE GUARD THAT PROVES THE GUARD WORKS.
//
// `npm run typecheck` reporting zero errors means nothing on its own — it reports zero whether the
// brands are enforced or silently erased. This file fails the check if they ever stop discriminating,
// using `@ts-expect-error`, which is itself an error when the line it marks does NOT error. So the
// build breaks in both directions: a real violation anywhere in the included tree, or this guard
// going hollow.
//
// Same reasoning as image-layout-test.mjs's "the guard actually discriminates — a file dropped from
// the COPY allowlist is caught". That guard existed on 08-10 and the class of bug it covers shipped
// again on 08-15, because nothing ran it. This one runs wherever `npm run typecheck` runs.
//
// It is type-level only: nothing here executes, and nothing imports it at runtime.

import type { ScopeId, LegacyName } from './identity';
import { agentMetaKey, agentGrantKey } from '../clawdbot/config-resolver/schema.mjs';

declare const scope: ScopeId;      // 'dm-ux0mz5ckp2r'      — what routing resolves to
declare const legacy: LegacyName;  // 'agent-xx9aff'  — what the EFS directory is called
declare const raw: string;         // straight off DynamoDB / JSON.parse / argv

// The correct call. If this ever errors, the brand has been made unusable rather than useful.
agentMetaKey(scope);
agentGrantKey(scope, '*');

// THE BUG, at compile time. This is `cron hydrate` reading `AGENT#agent-xx9aff/META` after
// eb14aeefa made hydration write only scope ids — a lookup that can no longer hit for any agent,
// and which shipped green because both sides are `string`.
// @ts-expect-error a LegacyName is not an identity in archie — resolve it first (META.efsRoot)
agentMetaKey(legacy);

// @ts-expect-error the same mistake in the grants partition, where it would silently under-grant
agentGrantKey(legacy, '*');

// An UNBRANDED string is refused too, and that is the point rather than an inconvenience: a value
// off the wire has no identity space until someone decides which one it is. The cast is where that
// decision becomes visible — see the boundary note in identity.d.ts.
// @ts-expect-error cast at the boundary and say which space it is
agentMetaKey(raw);
