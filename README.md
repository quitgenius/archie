# Archie

Fleets of Slack-native AI agents — each in its own hardware-isolated sandbox, created in seconds,
scaled to zero when idle.

Archie runs many autonomous agents behind a single gateway. Every agent is a full assistant with its
own workspace, memory, tools and skills, living inside its **own microVM**, so agents cannot see each
other's files, credentials or conversations. The gateway holds every Slack token; agents never
receive one.

```
                     ┌──────────────────────────────────────────────┐
   Slack  ──socket──▶│  gateway  (one connection, all tokens)       │
          ◀──proxy───│  routing · cron · streaming · authorization  │
                     └───────┬───────────────┬──────────────┬───────┘
                             │ invoke        │              │
                     ┌───────▼──────┐ ┌──────▼───────┐ ┌────▼─────────┐
                     │   agent A    │ │   agent B    │ │   agent C    │
                     │  own microVM │ │  own microVM │ │  own microVM │
                     └──────────────┘ └──────────────┘ └──────────────┘
                       isolated fs · memory · network · IAM role · egress
```

---

## What problem this solves

Most "AI agent for Slack" deployments are one process with one set of credentials, serving everyone.
That is fine for one agent and wrong for fifty: every user's data is reachable by every other user's
prompt, one compromised tool call leaks a token the whole deployment depends on, and "who was allowed
to do that?" has no answer you can audit.

Archie takes the opposite position. **Isolation is the unit of design, not a feature.**

- **One microVM per agent.** Not a container on a shared host, not a thread — a Firecracker microVM
  with its own CPU, memory, filesystem and network namespace, which is the same boundary cloud
  providers use between unrelated tenants.
- **The gateway owns every credential.** Agents post back through a token-less internal proxy. A
  compromised agent has no Slack token to leak, because it was never given one.
- **Per-agent IAM.** Each agent assumes a role derived from the capabilities it actually holds, so
  its AWS reach is bounded by policy rather than by convention.
- **Authorization is a policy document, not code.** Capabilities are granted by a Cedar policy plus a
  per-agent grant row, both auditable and diffable. See [Authorization](#authorization).
- **Scale to zero.** An idle agent costs nothing and cold-starts on demand.

---

## Repository layout

| Directory         | What it is                                                                       |
| ----------------- | -------------------------------------------------------------------------------- |
| `archie/`         | The fleet CLI — builds images, stages per-agent runtimes, healthchecks them, and moves the single pointer that decides what every agent runs. |
| `archie-gateway/` | The Slack gateway — one Socket Mode connection, per-agent routing, cron scheduling, reply streaming, approvals, and the authorization read/write path. |
| `archie-runner/`  | The agent runtime container — the [Pi](https://github.com/badlogic/pi) agent loop, a plugin host, skills, memory, and the per-turn permission filter. |
| `policy/`         | The Cedar authorization policy: schema, semantics, and the per-environment bindings an operator edits. |
| `types/`          | Shared type declarations used across the three trees.                             |

The three trees cross-import by sibling directory name, so keep the layout as-is.

---

## How a turn works

1. A message arrives on the gateway's single Socket Mode connection.
2. The gateway resolves it to a **scope** — a DM (`dm-<user>`) or a channel (`ch-<channel>`) — which
   is the identity everything else is keyed on. One scope, one agent, one workspace.
3. It claims a microVM for that scope, starting one if none is warm, and streams the turn in.
4. The runtime loads the agent's config, filters the tool set against the capabilities the agent
   actually holds this turn, and runs the agent loop.
5. Tool calls are checked at the capability level by a policy enforcement point before they execute.
6. Replies stream back through the gateway, which owns the tokens and does the posting.

Cold start to first response is a few seconds; a warm microVM streams immediately. Creating a
brand-new isolated agent and getting its first reply takes roughly half a minute.

---

## Authorization

Worth reading even if you take nothing else from this repository, because it is the part most agent
deployments get wrong.

Enforcement is at the **capability** level, not the tool level. Each tool declares one capability;
granting `runtime` unlocks every tool that declares it. The App Home UI browses by tool because that
is how people think, but every write is a capability, and the caller is responsible for showing the
blast radius before asking anyone to approve it.

There are two layers:

1. **The grant row** (`GRANT#<scope>`), read per turn from DynamoDB. A grant written in the UI takes
   effect on the next turn — no deploy, no restart. Provenance is recorded on the row (`manual:<user>`),
   which is the audit trail, makes revocation precise, and survives later recomputation.
2. **The Cedar policy**, deployed as an artifact. Some capabilities are *pinned*: authority comes from
   group membership alone and no grant row can confer them. Each pinned capability gets a
   `permit`/`forbid` pair, so membership is both necessary and sufficient:

   | | grant = yes | grant = no |
   | --- | --- | --- |
   | **member = yes** | allow | **allow** |
   | **member = no** | deny | deny |

   The `member=yes, grant=no → allow` cell is what the `permit` buys, and it is why a pinned
   capability has exactly one source of truth instead of two that can drift apart.

`policy/semantics.cedar` documents the design in full. The shipped capability set is an example —
see [What is not included](#what-is-not-included).

---

## Infrastructure requirements

Archie is not portable across clouds. It is built on AWS Bedrock AgentCore for the microVM boundary,
and that choice runs through the whole design.

### Required

| | |
| --- | --- |
| **AWS account** | With Bedrock AgentCore available in your region. AgentCore runtimes are the isolation boundary; there is no substitute abstraction in this codebase. |
| **Amazon Bedrock** | Model access enabled for whichever models your agents use. |
| **ECS (Fargate)** | Runs the gateway as a long-lived service. It holds the Socket Mode connection, so it is a single logical writer — plan for that when scaling. |
| **DynamoDB** | One table, single-table design. Key prefixes: `AGENT#`, `CONFIG#`, `META#`, `RUNTIME#`, `GRANT#`, `CONV#`. |
| **EFS** | Per-agent workspaces, memory and session transcripts, mounted into each microVM through its own access point. This is what makes an agent's state survive a microVM being destroyed. |
| **Secrets Manager** | Slack tokens, the gateway's shared secret, and per-agent third-party credentials. |
| **IAM** | Per-agent derived roles, plus a base policy. Agents get the reach their capabilities imply and no more. |
| **ECR** | Two images: the gateway and the agent runtime. The runtime must be **`linux/arm64`** — AgentCore microVMs are arm64. |
| **CloudWatch** | Logs, metrics and Logs Insights. The observability tooling queries it directly. |
| **A Slack app** | Socket Mode enabled, with a bot token and an app token. One app serves the whole fleet — see the note on rate limits below. |
| **Node.js ≥ 20** | The gateway targets Node 20+; images are built on Node 22. |

### Optional

- **X-Ray / OpenTelemetry** — the gateway and runtime are instrumented; traces stitch a turn from
  Slack through the gateway into the microVM.
- **SQS** — used for turn queueing under load.
- **S3** — file artifacts an agent publishes.
- **Service Quotas** — the CLI checks AgentCore resource counts against your limits before staging.

### Things worth knowing before you commit

- **One Slack app is one rate-limit bucket** for the entire fleet. Conversations APIs are tiered and
  paginated; at scale this shapes what the UI can render per interaction.
- **AgentCore has a warm-pool model.** The first session on a newly created runtime is slow; later
  sessions on an existing runtime are fast even after idle. Updating a runtime resets its warm pool.
- **AgentCore supports a subset of availability zones.** Check before choosing subnets, and note that
  bring-your-own-EFS forces VPC mode, whose ENIs have no public egress — you will need VPC endpoints
  or NAT.
- **Per-agent IAM roles and workload identities accumulate.** Plan teardown; some resources outlive
  the runtime that created them.

---

## Operating it

The `archie` CLI is the single writer for the fleet. Its shape:

```
archie preflight            # check the account, quotas and config before doing anything
archie image publish        # build and push the runtime image
archie fleet build|stage    # roll a release across agents
archie fleet healthcheck    # prove agents actually answer, not just that they exist
archie agent ensure-runtime # provision one agent end to end
archie agent teardown       # remove one agent and its resources
archie policy seed|publish  # derive and deploy the authorization policy
archie grants reconcile     # reconcile grant rows against installed skills
archie status               # what is deployed, and what is drifting
```

Two habits the design assumes: **provisioning an agent is not the same as serving traffic with it**
(stage it, then healthcheck with a real prompt), and **the image tag is the release identity** —
there is one pointer, and moving it is what deploys.

---

## Plugins and extensions

The runtime loads plugins through a small host interface (`plugin-sdk/`), so an agent's tool surface
is assembled per turn from what its config declares and what its capabilities permit. What ships:

| | What it does |
| --- | --- |
| `slack-reply-plugin/` | Posts replies back through the gateway's token-less proxy. This is the mechanism that lets an agent talk to Slack without ever holding a Slack token. |
| `openclaw-mcp-auth-plugin/` | An auth broker in front of upstream MCP servers — per-user OAuth2 with a token cache, so one agent's connection to a tool is not another user's. |
| `file-publish-plugin/` | `save_artifact`: an agent saves a file and shares it by expiring link, rather than pasting bytes into a conversation. |
| `hindsight-ingest/` | Long-term memory, ingesting into [Hindsight](https://hindsight.vectorize.io/). Memory is scoped per agent, and recall is a distinct capability from write. |

Two more extension surfaces:

- **Skills** (`agentcore-skills/`) — markdown instructions an agent loads on demand, declaring the
  tools they need. One worked example ships (`otel-debug`, which teaches an agent to query its own
  telemetry).
- **Workspace seeds** (`config-seed/new-agent-skeleton/`) — the `AGENTS.md` / `IDENTITY.md` /
  `SOUL.md` / `MEMORY.md` a brand-new agent's workspace is created from. Editing these is the fastest
  way to change what a newly created agent *is*.

---

## What is not included

This is an open-source build of a system that runs in a specific deployment. Everything that
described *that* deployment has been removed, and a few modules ship as stubs with their real export
surface so the code around them still reads correctly:

- **The connector marketplace** (`marketplace.js`, `custom-mcp.js`) — the App Home tabs render and
  render empty. Implement against your own connector platform, keeping the export surface.
- **The connector credential seam** (`connector-credential.js`) — the *contract* for per-agent
  third-party credentials is real and documented; the platform calls are not shipped.
- **The Cedar policy contents** — the statements are real, the capability set is an example, and the
  per-environment bindings (`pins.<env>.json`) are not included.
- **Config resolution and the integration test suite** — both were tightly coupled to one estate.

Where a module is stubbed, its header says so and describes what a real implementation must do.

## License

Copyright © 2026 Pelago Health.

Licensed under the [GNU Affero General Public License v3.0](./LICENSE) — see [NOTICE](./NOTICE).

The AGPL is a deliberate choice rather than a default. Archie is a network service by construction:
people interact with it through Slack and never receive a copy, which is precisely the case the
ordinary GPL does not reach. Under section 13, **if you run a modified version of Archie as a
service, you must offer its users the source of your modified version.**
