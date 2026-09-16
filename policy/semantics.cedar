// Archie authorization SEMANTICS — shared, one copy, identical in every environment.
//
// This file says what is true about capabilities everywhere: which are generally available, that a
// grant row confers authority, and which are grant-inert (authority comes from group membership
// alone, and no DynamoDB row can override that). It contains NO scope ids and NO environment
// specifics — those are entity data in pins.<env>.json, which is the only file an operator edits.
//
// OPEN-SOURCE BUILD. The statements below are the real ones; the CAPABILITIES they name are
// examples. A deployment's capability set is its own — which external systems an agent may reach is
// the most deployment-specific thing in the whole design — so the pins files and the per-capability
// blocks are not shipped. What is shipped is the shape: the two layers, the pin construct, and the
// argument for why it is built this way. Add your own capabilities in the B and C sections.
//
// WHY THE SEMANTICS/BINDINGS SPLIT: semantics duplicated per environment cannot be guarded. With
// distinct files, divergence is legitimate by construction, so no lockstep test is possible. So there
// is one semantics file and the CLI always includes it; `--capabilities pins.<env>.json` selects only
// the bindings half. One file to configure, no duplicated semantics, and you cannot forget the shared
// half because it is not selectable.
//
// Cedar has no imports: a .cedar file is a flat sequence of permit/forbid statements with no include
// directive or preprocessor. Composition happens one level up — the CLI assembles a PolicySet from
// this file plus the bindings, with the schema and entity data as separate inputs.
//
// TWO CEDAR DEFAULTS DO REAL WORK HERE, so neither needs stating:
//   1. No matching permit is a DENY. So a capability's absence below is not a statement, and there is
//      nothing to keep in sync.
//   2. `forbid` beats every `permit`. So a pin cannot be overridden by a grant row, which is the
//      entire property layer 1 could not express.

// ─────────────────────────────────────────────────────────────────────────────
// A1. GENERALLY AVAILABLE — the ambient set every scope holds without a grant.
//
// Membership is semantics (a fact about the capability, not about an environment) and lives in
// semantics.json. Cedar is the single declaration of "generally available"; the JS map in
// agentcore-pi/permissions/capabilities.mjs is derived from it.
// ─────────────────────────────────────────────────────────────────────────────
permit (
  principal,
  action == Archie::Action::"use",
  resource in Archie::CapGroup::"baseline"
);

// ─────────────────────────────────────────────────────────────────────────────
// A2. THE GRANT ROW — layer 1, read per turn.
//
// The only dynamic input to the whole system. `context.grants` is the scope's effective capability
// set for this turn, from GRANT#<scope>/SCOPE#*, so a grant written in the Tools tab takes effect on
// the next turn with no deploy and no restart. Layer 1 stays exactly as it is; this statement is how
// layer 2 acknowledges it.
//
// Reads resource.name — see the schema's note on why Capability must carry that attribute.
// ─────────────────────────────────────────────────────────────────────────────
permit (
  principal,
  action == Archie::Action::"use",
  resource
) when { context.grants.contains(resource.name) };

// ─────────────────────────────────────────────────────────────────────────────
// B. GRANT-INERT CAPABILITIES — authority comes from group membership alone.
//
// Each `forbid` below beats A2, so for these a DynamoDB row confers nothing. Authority comes only
// from membership of the named ScopeGroup, which is supplied per environment.
//
// MEMBERSHIP IS NECESSARY AND SUFFICIENT — these are POLICY PINS. Each capability gets a PAIR: the
// `permit` makes group membership sufficient, the `forbid` makes it necessary. So membership ⟺
// access. Deploy the policy and it works; remove a scope and it loses access. **No grant row is
// involved, needed, or consulted**, which is the whole point:
//
//     member=yes, grant=yes  ->  allow          member=no,  grant=yes  ->  deny
//     member=yes, grant=no   ->  ALLOW          member=no,  grant=no   ->  deny
//
// (Verified against cedar-wasm 4.12.0; the `member=yes, grant=no -> allow` row is what the permit
// buys.)
//
// THIS SUPERSEDES AN EARLIER "PINNING IS NOT GRANTING" DESIGN, and the reason for the change is the
// reason to prefer this shape. With a `forbid` alone, membership only meant "may be granted", so a
// pinned capability still needed a DynamoDB row — two sources for one fact. Remove a scope from the
// group and the row survives, still saying "granted", now conferring nothing: the table drifts from
// the policy and implies access that does not exist. With a permit+forbid pair there is one place the
// fact lives.
//
// CONSEQUENCE, and it is deliberate: **these capabilities must be UNGRANTABLE from DynamoDB.** A row
// for one is ineffective, misleading, and the only way drift can re-enter, so the writers must refuse
// it and a deploy should delete any that exist. Enforcement is in Cedar (a row confers nothing) and
// in the app (`assertGrantable`, the Tools tab, the grant reconcile, hydration).
//
// Note what CANNOT enforce it: a DynamoDB condition. A LeadingKeys-style restriction is keyed on the
// PRINCIPAL (`GRANT#<scope>`), while this is keyed on the CAPABILITY, which lives in the item BODY,
// and conditions cannot see inside an item. Plan the enforcement you can actually express.
//
// A SECOND CONSEQUENCE, also deliberate: **a skill install no longer confers these.** Where a
// capability's holders are skill-derived, installing that skill stops granting it — the group must be
// edited and the policy deployed. For capabilities that require a security review that is the point;
// it is nonetheless a real behaviour change.
//
// The pair is identical in shape for every pinned capability: group SIZE is the only difference and
// it lives in the bindings. A pin to nobody, to one scope, and to eight are one construct.
// ─────────────────────────────────────────────────────────────────────────────

// B1. EXAMPLE — a read-only query capability against some connected data source.
permit (
  principal in Archie::ScopeGroup::"pin.demo_query_app",
  action == Archie::Action::"use",
  resource == Archie::Capability::"demo_query_app"
);
forbid (
  principal,
  action == Archie::Action::"use",
  resource == Archie::Capability::"demo_query_app"
) unless { principal in Archie::ScopeGroup::"pin.demo_query_app" };

// B2. EXAMPLE — SQL against a connected warehouse. Write the summary in grants.js for the person
// clicking Approve: the blast radius and the trust boundary, not the tool's mechanics.
permit (
  principal in Archie::ScopeGroup::"pin.demo_warehouse",
  action == Archie::Action::"use",
  resource == Archie::Capability::"demo_warehouse"
);
forbid (
  principal,
  action == Archie::Action::"use",
  resource == Archie::Capability::"demo_warehouse"
) unless { principal in Archie::ScopeGroup::"pin.demo_warehouse" };

// B3. Reads every OTHER agent's telemetry. Self-observability is baseline; this one crosses the
// boundary to observing other people's agents, which is why it is pinned rather than grantable.
permit (
  principal in Archie::ScopeGroup::"pin.otel.fleet",
  action == Archie::Action::"use",
  resource == Archie::Capability::"otel.fleet"
);
forbid (
  principal,
  action == Archie::Action::"use",
  resource == Archie::Capability::"otel.fleet"
) unless { principal in Archie::ScopeGroup::"pin.otel.fleet" };

// B4. TEST-ONLY, for the derived-role IAM harness. Should be pinned to [] outside a sandbox.
permit (
  principal in Archie::ScopeGroup::"pin.sandbox-probe",
  action == Archie::Action::"use",
  resource == Archie::Capability::"sandbox-probe"
);
forbid (
  principal,
  action == Archie::Action::"use",
  resource == Archie::Capability::"sandbox-probe"
) unless { principal in Archie::ScopeGroup::"pin.sandbox-probe" };

// ─────────────────────────────────────────────────────────────────────────────
// C. NARROWED CAPABILITIES — grant-inert, with groups SEEDED from today's holders.
//
// Same statement shape as B; the only difference is that these groups start non-empty, because the
// capability already has holders. Seeding from current holders means **no scope loses anything on
// day one** — every present holder is in its group — while the capability becomes grant-inert, so no
// NEW scope can acquire it through a DynamoDB row. That is the whole gain: the set stops growing by
// accident.
//
// SEEDING PINS, IT DOES NOT NARROW. Day one delivers explicitness, not reduced exposure: the same
// scopes hold the same capabilities, but the set is now declared, enumerable, diffable and
// deploy-gated for future additions. Anyone reading "pinned" as "secured" has misread it. Narrowing
// is a separate, later act, and it now has an enumeration to work from.
//
// HOW TO SEED A GROUP, because this is the step most likely to be got wrong. A ScopeGroup holds
// SCOPE ids, not agent names — archie rekeys identity to the scope (`dm-<user>` / `ch-<channel>`), so
// an agent name is not a principal, and seeding agent names would deny every holder while looking
// correct. Derive the mapping with `scopeIdFor()` rather than by hand, and check that every agent
// maps and that none carries more than one binding before trusting the result.
// ─────────────────────────────────────────────────────────────────────────────

// C1. EXAMPLE — writes to a shared knowledge bank that other agents recall from. Narrowed rather
// than baseline because a write is visible to every reader of the bank.
permit (
  principal in Archie::ScopeGroup::"pin.hindsight.write",
  action == Archie::Action::"use",
  resource == Archie::Capability::"hindsight.write"
);
forbid (
  principal,
  action == Archie::Action::"use",
  resource == Archie::Capability::"hindsight.write"
) unless { principal in Archie::ScopeGroup::"pin.hindsight.write" };
