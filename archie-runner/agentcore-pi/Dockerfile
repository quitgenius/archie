# Pi-only AgentCore image. Node 22, pinned @mariozechner/pi-*@0.61.1 + Bedrock SDK +
# @vectorize-io/hindsight-client (Pi-native recall) + esbuild-bundled compat plugins
# (connector). NO OpenClaw runtime.
#
# BUILD CONTEXT is docker/archie-runner/ (needs the sibling connector-session-plugin source):
#   docker build --platform linux/arm64 -f agentcore-pi/Dockerfile -t <ecr>:pi-N docker/archie-runner
#
# ── stage 0: lint (DISCARDED — see the gate at the end of stage 2; nothing from here ships) ──
# WHY IN THE BUILD: three bugs reached a live sandbox on 2026-08-13 through 786 green unit tests
# and `node --check` (undeclared dependency, `log is not defined`, out-of-scope `docClient`).
# Rules + full rationale: docker/eslint.config.mjs. ERROR-level rules gate the build; `no-empty` is
# warn and must NOT fail it, so plain `eslint` (which exits non-zero on errors only) — no
# --max-warnings.
#
# REQUIRES AN EXTRA BUILD CONTEXT. eslint.config.mjs lives at docker/, one level ABOVE this image's
# build context (docker/archie-runner/), and a Dockerfile cannot COPY above its context. The Makefile
# passes `--build-context lintroot=.` from docker/. A hand-run `docker build` without it fails
# loudly on the first COPY --from=lintroot rather than silently skipping the gate. The alternative
# — widening the context to docker/ — would mean re-prefixing every COPY below, and this image's
# context is documented as load-bearing in the Makefile precisely because it has bitten people.
#
# node_modules is required, not optional: n/no-missing-import resolves against a real tree.
# --ignore-scripts skips duckdb's node-gyp source build — resolution only needs the package to
# exist on disk, not to be compiled, and that build is the expensive part of this install.
FROM node:22-slim AS lint
WORKDIR /lint
COPY --from=lintroot package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY --from=lintroot eslint.config.mjs ./
COPY agentcore-pi/package.json ./archie-runner/agentcore-pi/
RUN cd archie-runner/agentcore-pi && npm install --omit=dev --ignore-scripts --no-fund --no-audit
COPY config-resolver/package.json config-resolver/package-lock.json ./archie-runner/config-resolver/
RUN cd archie-runner/config-resolver && npm ci --omit=dev --no-fund --no-audit
COPY agentcore-pi/*.mjs agentcore-pi/*.cjs ./archie-runner/agentcore-pi/
COPY agentcore-pi/openclaw-compat/ ./archie-runner/agentcore-pi/openclaw-compat/
COPY agentcore-pi/permissions/ ./archie-runner/agentcore-pi/permissions/
COPY agentcore-pi/spike/ ./archie-runner/agentcore-pi/spike/
COPY config-resolver/*.mjs config-resolver/*.cjs ./archie-runner/config-resolver/
RUN npx eslint archie-runner/agentcore-pi archie-runner/config-resolver && touch /lint/PASSED

# ── stage 1: bundle the compat plugins to CJS (esbuild). The plugins import their entry
#    helper from the local ../plugin-sdk shim (definePluginEntry) — NO OpenClaw dependency
#    at all. Mirrors the P3 spike build. ──
FROM node:22-slim AS plugins
WORKDIR /build
COPY plugin-sdk/ ./plugin-sdk/
COPY connector-session-plugin/ ./connector-session-plugin/
RUN cd connector-session-plugin \
  && npm install --omit=dev --no-fund --no-audit \
  && npm install esbuild --no-save --no-fund --no-audit \
  && npx esbuild index.ts --bundle --format=cjs --platform=node --target=node22 \
       --outfile=/build/plugins/connector-session-plugin.cjs

# demo-cache-plugin: DuckDB-over-Parquet analytics. `duckdb` is a native addon → keep it
# EXTERNAL (installed + built in the runtime stage); @aws-sdk/client-s3 (fetch_data) bundles
# fine. --ignore-scripts so stage-1 install doesn't waste time building the external addon.
COPY demo-cache-plugin/ ./demo-cache-plugin/
RUN cd demo-cache-plugin \
  && npm install --omit=dev --ignore-scripts --no-fund --no-audit \
  && npm install esbuild --no-save --no-fund --no-audit \
  && npx esbuild index.ts --bundle --format=cjs --platform=node --target=node22 \
       --external:duckdb \
       --outfile=/build/plugins/demo-cache-plugin.cjs

# openclaw-mcp-auth-plugin: per-sender MCP proxy (undici is pure JS → bundles; no native deps).
COPY openclaw-mcp-auth-plugin/ ./openclaw-mcp-auth-plugin/
RUN cd openclaw-mcp-auth-plugin \
  && npm install --omit=dev --no-fund --no-audit \
  && npm install esbuild --no-save --no-fund --no-audit \
  && npx esbuild index.ts --bundle --format=cjs --platform=node --target=node22 \
       --outfile=/build/plugins/openclaw-mcp-auth-plugin.cjs

# slack-reply-plugin: outbound Slack through the dispatcher proxy, which holds ARCHIE'S OWN
# bot token (the agent never gets a Slack token). Zero runtime deps → a plain bundle.
COPY slack-reply-plugin/ ./slack-reply-plugin/
RUN cd slack-reply-plugin \
  && npm install --omit=dev --no-fund --no-audit \
  && npm install esbuild --no-save --no-fund --no-audit \
  && npx esbuild index.ts --bundle --format=cjs --platform=node --target=node22 \
       --outfile=/build/plugins/slack-reply-plugin.cjs

# file-publish-plugin: `save_artifact` — S3 upload + a 24h presigned URL. @aws-sdk/client-s3 and
# s3-request-presigner are pure JS and bundle fine (demo-cache-plugin already bundles the former).
COPY file-publish-plugin/ ./file-publish-plugin/
RUN cd file-publish-plugin \
  && npm install --omit=dev --no-fund --no-audit \
  && npm install esbuild --no-save --no-fund --no-audit \
  && npx esbuild index.ts --bundle --format=cjs --platform=node --target=node22 \
       --outfile=/build/plugins/file-publish-plugin.cjs

# ── stage 2: runtime ──
FROM node:22-slim
WORKDIR /app

# python3/make/g++ are here for `duckdb`'s node-gyp source build — it has no guaranteed
# arm64 prebuilt for every release. node-pre-gyp uses a prebuilt when available and only
# falls back to compiling. (Kept in the image; this is a migration PoC, size is secondary.)
# python3/make/g++ are for duckdb's node-gyp source build (no guaranteed arm64 prebuilt).
# curl is for the agent's own exec tool — lets a turn diagnose network reachability (e.g. an
# internal MCP server ALB) from inside the actual runtime, not just from an external test task.
#
# jq is for the SHELL SKILLS. Their scripts (cw.sh, dd.sh, cwq.sh, aws-ro.sh, person79b333-secrets.sh) are
# back in service after the G3/G4 in-process ports were reverted, and while none of the five parses
# JSON with jq TODAY, every one of them emits it — an agent following the prose will reach for jq
# immediately, and its absence is the class of failure that presents as "the skill is broken".
# git is for the GITHUB SKILLS. `understand`/`understand-diff` shell out to `git rev-parse` and
# `git diff` for staleness detection, and create-agent/agent-u0yebw clone, branch, commit and push.
# Without the binary those are not degraded, they are impossible — measured on the live image
# (2026-09-16): `git: not found`, `gh: not found`. See archie-agent-builder-port.md.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ curl jq git \
  && rm -rf /var/lib/apt/lists/*

# THE GITHUB CLI, for agent-u0yebw's `gh pr create`. From GitHub's own apt repo rather than a
# tarball so the signature is checked and upgrades are an apt bump; pinned to the repo, not a
# version, matching how the AWS CLI below is pinned to its image tag.
#
# ONE AGENT USES THIS. `gh` is on PATH for every runtime because the image is fleet-uniform, but the
# TOKEN is not: GH_CONFIG_TOKEN resolves only for an agent holding `agent-provisioning`
# (pi-entrypoint), so on every other agent `gh` is present and unauthenticated.
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# THE AWS CLI, for the shell skills. Copied from the official image rather than curl|unzip: no extra
# build deps (unzip), no checksum to maintain by hand, and the tag pins the version.
#
# WHY IT IS BACK. aws-readonly/cloudwatch-logs/datadog-logs/aws-person79b333-secrets/support-aws-debug all
# shell out to `aws`. The ports that replaced them with in-process SDK tools each implemented a
# STARTER surface — aws_readonly was five actions over two SDK clients against the CLI's whole
# read surface — so the skills were functionally narrower than in OpenClaw. Reverting to the scripts
# restores parity; that needs the binary.
#
# ON PATH, deliberately. The scripts invoke bare `aws`, exactly as they do under OpenClaw, and parity
# is the point of the revert. Installing it off-PATH would hide it from an agent that has no business
# with it, but it would also mean patching every script and diverging from the sandra source.
# Containment is the SKILL install gate (files only materialise for installed skills) and IAM (the
# reader role is only assumable by agents whose derived role carries the statement) — not the
# filesystem.
#
# SIZE: this is the largest single addition to the image. Measure the cold-boot delta before and
# after (BOOT_PHASE name=ready) — the warm pool re-pulls on every runtime update and those pulls
# egress via NAT.
COPY --from=amazon/aws-cli:2.31.16 /usr/local/aws-cli/ /usr/local/aws-cli/
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws

COPY agentcore-pi/package.json ./
RUN npm install --omit=dev --no-fund --no-audit

# Teach the pinned pi-ai that Claude 5 uses ADAPTIVE thinking. Without this every Claude 5 turn fails
# in ~1s ("thinking.type.enabled is not supported for this model"), because pi-ai gates the adaptive
# shape on a hard-coded list of Claude 4 ids. The script FAILS THE BUILD if it cannot apply — a patch
# that silently no-ops on an upgrade is how a fleet quietly reverts to broken turns. See the file for
# why there is no seam to use instead. Runs here, immediately after npm install, so no later layer can
# observe an unpatched module.
COPY agentcore-pi/patch-pi-ai-adaptive-thinking.mjs ./
RUN node patch-pi-ai-adaptive-thinking.mjs && rm patch-pi-ai-adaptive-thinking.mjs

# Teach the SAME pinned pi-ai that Claude 5 supports PROMPT CACHING — gated on the same kind of
# hard-coded Claude 4 id list, in the same file. Its failure mode is the opposite of the one above,
# and worse for it: turns keep succeeding, they just stop writing cache points and re-pay full price
# for the entire prefix on every call. Measured 92% cache-hit before the fleet moved to Sonnet 5
# (TURN-LATENCY-REPORT.md) and 0% after. Also FAILS THE BUILD if it cannot apply, because an
# unpatched module is invisible at runtime.
COPY agentcore-pi/patch-pi-ai-prompt-cache.mjs ./
RUN node patch-pi-ai-prompt-cache.mjs && rm patch-pi-ai-prompt-cache.mjs

# THIS LIST IS AN ALLOWLIST, and a module missing from it does not fail the build — it fails at
# RUNTIME, on the agent's first invoke, as ERR_MODULE_NOT_FOUND. That is exactly how
# config-fingerprint.mjs shipped broken: it was extracted out of pi-adapter.mjs (importing the
# adapter runs boot() at module load, so the fingerprint had to move to be testable) and adding it
# here was forgotten. Nothing caught it until a from-scratch stack ran its first turn.
COPY agentcore-pi/pi-runtime.mjs agentcore-pi/bedrock-model-registry.mjs agentcore-pi/session-config-refresh.mjs agentcore-pi/pi-adapter.mjs agentcore-pi/config-map.mjs \
     agentcore-pi/config-fingerprint.mjs agentcore-pi/agent-config.mjs \
     agentcore-pi/memory-tool.mjs agentcore-pi/session-store.mjs \
     agentcore-pi/hindsight-extension.mjs agentcore-pi/hindsight-client-recall.mjs \
     agentcore-pi/knowledge-tools.mjs agentcore-pi/knowledge-write-tools.mjs agentcore-pi/fetch-error.mjs \
     agentcore-pi/clock-extension.mjs \
     agentcore-pi/model-context-extension.mjs \
     agentcore-pi/otel-export.cjs agentcore-pi/pi-entrypoint.mjs agentcore-pi/sse-contract.mjs \
     agentcore-pi/bedrock-dispatch-mark.mjs \
     agentcore-pi/reply-usage.mjs agentcore-pi/usage-attrs.mjs \
     agentcore-pi/turn-outcome.mjs agentcore-pi/tool-outcome.mjs \
     agentcore-pi/dispatcher-client.mjs agentcore-pi/dispatcher-token.mjs \
     agentcore-pi/cron-tool-core.mjs agentcore-pi/cron-tool.mjs agentcore-pi/workspace-seed.mjs \
     agentcore-pi/spawn-tool-core.mjs agentcore-pi/spawn-tool.mjs \
     agentcore-pi/skill-sync.mjs agentcore-pi/skill-scope.mjs agentcore-pi/tls-scoped.mjs \
     agentcore-pi/trace-context.mjs agentcore-pi/otel-tool.mjs \
     agentcore-pi/sandbox-probe-tool.mjs agentcore-pi/observability-iam.cjs agentcore-pi/tool-registry.mjs \
     agentcore-pi/tool-declarations.mjs ./
# The OTEL self-observability tools (otel-tool.mjs) load the query/metric corpus from the shared
# single source of truth — agentcore-observability/insight-queries.js (the same file the dashboard
# builder + BDD suite use). Copy it in next to the adapter so the tools and the dashboard can't drift.
# NB rename to .cjs: the source is CommonJS (module.exports) but /app/package.json is "type":"module",
# so a plain .js here would be parsed as ESM and crash the adapter on boot (module is not defined).
COPY agentcore-observability/insight-queries.js ./insight-queries.cjs
COPY agentcore-pi/openclaw-compat/ ./openclaw-compat/
COPY agentcore-pi/permissions/ ./permissions/
COPY --from=plugins /build/plugins/ ./plugins/

# The config-resolver (resolve-config + its DDB client/schema — brings its own aws-sdk, as
# node:22-slim has none) and config-seed (just the hand-authored new-agent-skeleton/ now — the
# skill library + catalog live in DynamoDB). The entrypoint resolves this agent's config from
# DynamoDB in-process (agent-config.mjs imports resolve-config.mjs from CONFIG_RESOLVER_DIR below —
# this COPY is what makes that specifier resolve, and the reason it is a dynamic import at all is
# that this Dockerfile flattens agentcore-pi/ to /app/ while config-resolver/ lands one level in);
# the adapter materializes skills + seeds the workspace onto EFS from DynamoDB post-mount.
COPY config-resolver/ ./config-resolver/
RUN cd config-resolver && npm install --omit=dev --no-fund --no-audit
COPY config-seed/ ./config-seed/
ENV CONFIG_RESOLVER_DIR=/app/config-resolver CONFIG_SEED_DIR=/app/config-seed

# IMPORT GATE. Every relative import reachable from the entrypoint must RESOLVE inside the image.
#
# The COPY above is an allowlist, and a module missing from it does not fail the build — it fails on
# the agent's first invoke as ERR_MODULE_NOT_FOUND, after provisioning has already created a role, a
# Connector project, an access point and a runtime. That is a very expensive place to discover a typo.
# It is not hypothetical: config-fingerprint.mjs shipped missing exactly this way, and nothing caught
# it until a from-scratch stack ran its first turn.
#
# ESLINT CANNOT COVER THIS. It checks the SOURCE TREE, where every one of these files exists; the
# question here is which of them were copied INTO the image, which only the image can answer. The
# dispatcher image has had the same gate for the same reason.
#
# Walks statically from the entrypoint rather than checking a hand-kept list, so a new import is
# covered the moment it is written — a list would need the same maintenance the COPY does, and would
# drift from it in the same way.
RUN node -e "const fs=require('fs'),path=require('path');const seen=new Set(),missing=[];const walk=(f)=>{  if(seen.has(f))return; seen.add(f);  if(!fs.existsSync(f)){missing.push(f+' (not copied into the image)');return;}  const src=fs.readFileSync(f,'utf8');  for(const m of src.matchAll(/(?:from|import)\s*\(?\s*['\"](\.[^'\"]+)['\"]/g)){    walk(path.normalize(path.join(path.dirname(f),m[1])));  }};walk('pi-entrypoint.mjs');if(missing.length){console.error('IMPORT GATE FAILED — these are imported but absent from the image:');for(const m of missing)console.error('  '+m);console.error('Add them to the COPY list in agentcore-pi/Dockerfile.');process.exit(1);}console.log('import gate OK — '+seen.size+' modules resolve from pi-entrypoint.mjs');"

# LINT GATE. Fails the build unless stage 0 finished clean. --mount=type=bind pulls NOTHING into
# this layer (unlike COPY --from), so no eslint artefact ships. It also makes stage 0 a build
# dependency — BuildKit prunes an unreferenced stage, which would silently never run it.
# Deliberately LAST: the gate's cache key includes stage 0, which changes on every source edit, so
# an earlier position would invalidate the apt/npm/duckdb layers on every build.
RUN --mount=type=bind,from=lint,source=/lint,target=/lint \
    test -f /lint/PASSED && echo 'eslint gate OK'

# MCP_AUTH_NONINTERACTIVE: no inbound OAuth2 callback listener / browser flow — an ephemeral
# microVM can't host one. This stays set: it is what keeps the callback SERVER from starting.
#
# MCP_AUTH_BROKERED: completion goes through the public ingress instead. The flow may BEGIN (the
# verifier is persisted to the agent's EFS dir, since the microVM won't outlive the browser round
# trip) and a later turn exchanges the code the forwarder Lambda landed in DynamoDB. Without this
# the plugin stays refresh-only off a hand-seeded token, which does not scale past a few agents.
#
# Both are needed, and they are not contradictory: NONINTERACTIVE governs the listener, BROKERED
# governs where completion happens. See openclaw-mcp-auth-plugin/src/brokered.ts.
ENV NODE_ENV=production PORT=8080 PI_PLUGINS_DIR=/app/plugins MCP_AUTH_NONINTERACTIVE=1 MCP_AUTH_BROKERED=1
EXPOSE 8080
# Entrypoint resolves config from DynamoDB, then hands off to the adapter (which seeds the
# workspace + materializes the skill library onto EFS from DynamoDB once the mount attaches).
CMD ["node", "pi-entrypoint.mjs"]
