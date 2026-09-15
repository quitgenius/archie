# ── stage: lint (DISCARDED — see the gate at the bottom; nothing from here ships) ─────────────
# WHY IN THE BUILD. The COPY-allowlist preflight below already lives in the Dockerfile because it
# must not be bypassable. Lint is the same argument: on 2026-08-13 three bugs reached a live sandbox
# through 786 green unit tests and `node --check` — a missing package.json dependency, a
# `log is not defined`, and an out-of-scope `docClient` — because nothing between "tests pass" and
# "image runs in AWS" looked at them. Rules and the full rationale: docker/eslint.config.mjs.
#
# ERROR-level rules gate this build. `no-empty` is warn and MUST NOT fail it — plain `eslint` exits
# non-zero on errors only, so do NOT add --max-warnings.
#
# node_modules is required, not optional: n/no-missing-require resolves against a real tree, so a
# declared-but-uninstalled package reads as missing. The install layers key on package.json alone,
# so they cache across source-only rebuilds; only the COPY of sources + the eslint run re-execute.
FROM node:22-slim AS lint
WORKDIR /lint
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY archie-gateway/package.json archie-gateway/package-lock.json* ./archie-gateway/
# Full install (incl. devDependencies) so the *.test.js and publish-image.mjs files lint exactly as
# they do locally — the dispatcher's devDependencies are two packages, so this is cheap.
RUN cd archie-gateway && npm install --no-fund --no-audit
COPY eslint.config.mjs ./
COPY archie-gateway/*.js archie-gateway/*.mjs ./archie-gateway/
# *.test.js is excluded HERE ONLY. Tests import across the tree (cron-hydrator.test.js pulls
# ../archie-runner/agentcore-pi/cron-tool-core.mjs) into paths that exist in the source tree but not in
# this stage, so n/no-missing-import would report the stage's own layout as a defect. Tests are
# linted in full by `npm run lint`; this gate's job is the code that ships.
RUN npx eslint archie-gateway --ignore-pattern '**/*.test.js' && touch /lint/PASSED

FROM node:22-slim

# ca-certificates for outbound TLS (Slack Web API + AWS). No git — config is read from DynamoDB.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    if getent group 1000 >/dev/null; then \
      groupmod -n dispatcher "$(getent group 1000 | cut -d: -f1)" || true; \
    else \
      groupadd -r dispatcher -g 1000; \
    fi; \
    if getent passwd 1000 >/dev/null; then \
      usermod -d /app -l dispatcher -g dispatcher "$(getent passwd 1000 | cut -d: -f1)" || true; \
    else \
      useradd -r -u 1000 -g dispatcher -m -d /app dispatcher; \
    fi; \
    mkdir -p /app && \
    chown -R dispatcher:dispatcher /app

WORKDIR /app

# NB build context is `docker/` (not `docker/archie-gateway/`) so the image can ship the agent's
# config-resolver ESM as the single source of truth for the cap→IAM map (A2 / §9.8). All source
# paths below are therefore prefixed `archie-gateway/`. Build:
#   docker build --platform=linux/amd64 -f archie-gateway/Dockerfile -t <ecr>/…-dispatcher:<tag> .
COPY --chown=dispatcher:dispatcher archie-gateway/package.json archie-gateway/package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit

COPY --chown=dispatcher:dispatcher archie-gateway/index.js archie-gateway/marketplace.js archie-gateway/approvals-store.js archie-gateway/approvals-routes.js archie-gateway/approvals-wake.js archie-gateway/owners.js archie-gateway/derived-role.js archie-gateway/streaming.js archie-gateway/conversations.js archie-gateway/metrics.js archie-gateway/file-ref.js archie-gateway/agentcore-client.js archie-gateway/agentcore-provisioning.js archie-gateway/dispatcher-metrics.js archie-gateway/tracing.js archie-gateway/backpressure.js archie-gateway/connector-credential.js archie-gateway/session-tracker.js archie-gateway/image-source.js archie-gateway/turn-queue.js archie-gateway/spec-diff.js archie-gateway/cron-home.js archie-gateway/grants.js archie-gateway/slack-proxy-routes.js archie-gateway/agent-scope.js archie-gateway/agent-directory.js archie-gateway/agent-labels.js archie-gateway/semaphore.js archie-gateway/sdk-http.js archie-gateway/runtime-registry.js archie-gateway/runtime-quota-metrics.js archie-gateway/session-tracker.js archie-gateway/files-store.js \
    archie-gateway/cron-service.js archie-gateway/cron-runner.js archie-gateway/cron-store.js archie-gateway/cron-fire.js archie-gateway/cron-delivery.js archie-gateway/cron-api.js archie-gateway/cron-hydrator.js archie-gateway/cron-metrics.js archie-gateway/cron-runner-flag.js archie-gateway/cron-inventory-metrics.js archie-gateway/peer-synth-fixture.js archie-gateway/hydrate-e2e.js archie-gateway/delivery-e2e.js archie-gateway/registry-e2e.js \
    archie-gateway/policy-derive.js archie-gateway/custom-mcp.js ./

# A2 (§9.8): the agent's cap→IAM map + pure derived-role builder — the SINGLE source of truth,
# dynamic-imported by derived-role.js. No CommonJS mirror of the cross-account ARN table.
# §9.9a: the dispatcher pre-writes a brand-new agent's workspace SEED at provision time, so the
# runtime needs no DynamoDB write at all. Both images build from the same `docker/` context, so the
# skeleton and the readSkeleton() that templates it are COPIED FROM THE SAME SOURCE the agent image
# uses (archie-runner/config-seed + archie-runner/agentcore-pi/workspace-seed.mjs) — same commit, no mirrored
# implementation to drift, no extra deploy step to publish the skeleton anywhere.
COPY --chown=dispatcher:dispatcher archie-runner/config-seed/new-agent-skeleton/ ./config-seed/new-agent-skeleton/
COPY --chown=dispatcher:dispatcher archie-runner/agentcore-pi/workspace-seed.mjs ./agentcore-pi/
COPY --chown=dispatcher:dispatcher archie-runner/agentcore-pi/bedrock-model-registry.mjs ./agentcore-pi/

COPY --chown=dispatcher:dispatcher archie-runner/config-resolver/skill-iam-requirements.mjs archie-runner/config-resolver/derive-exec-role.mjs \
     archie-runner/config-resolver/caps-from-config.mjs archie-runner/config-resolver/schema.mjs \
     archie-runner/config-resolver/skill-pins.mjs ./config-resolver/

# The tool/capability model the App Home Tools tab renders — THE AGENT'S OWN DECLARATIONS, not a
# generated copy of them. tool-declarations.mjs has zero imports and provider-registry.mjs reads it
# rather than tool-registry.mjs, so neither pulls in the Pi harness (every tool module does
# `const T = piAi.Type` at module scope, and pi-runtime.mjs top-level-awaits the Pi packages). That is
# what makes importing them here possible at all, and what removed the generated catalogue that used
# to stand in for them.
#
# THE DIRECTORY STRUCTURE IS LOAD-BEARING, unlike the flattened config-resolver COPY above:
# provider-registry.mjs imports `../tool-declarations.mjs` and `./capabilities.mjs` relatively, so
# these must keep their agentcore-pi/ + permissions/ nesting or those specifiers resolve to nothing.
COPY --chown=dispatcher:dispatcher archie-runner/agentcore-pi/tool-declarations.mjs ./agentcore-pi/
# baseline.generated.mjs is imported BY capabilities.mjs (the Cedar-owned baseline set), so it is not
# optional here: without it the dispatcher MODULE_NOT_FOUNDs on first use of the Tools tab. The agent
# image copies permissions/ as a whole directory and so picks it up for free; this allowlist does not.
COPY --chown=dispatcher:dispatcher archie-runner/agentcore-pi/permissions/capabilities.mjs archie-runner/agentcore-pi/permissions/provider-registry.mjs archie-runner/agentcore-pi/permissions/baseline.generated.mjs ./agentcore-pi/permissions/

# ── BUILD-TIME GATES. Both run against the ASSEMBLED image, after every COPY. ─────────────────
#
# 1. COPY-ALLOWLIST PREFLIGHT. The COPYs above are an explicit allowlist, so adding a new local
#    module to index.js and forgetting to list it here produces a MODULE_NOT_FOUND at container
#    start — a silent crash-loop after a green build and a successful push (this has happened
#    twice). Resolve every local specifier in the shipped entrypoints at BUILD time instead.
#
#    It checks require('./…') AND import('./…'). The dynamic-import leg matters because
#    derived-role.js / agentcore-client.js / marketplace.js / cron-runner-flag.js bridge to the
#    agent's ESM with an in-image path first (`./config-resolver/schema.mjs`) and a source-tree
#    fallback. Only the in-image path can be verified here, and it cannot be verified by eslint at
#    all (it does not exist in the source tree) — which is exactly why docker/eslint.config.mjs turns
#    n/no-missing-import off for those files and points at this check. Note the position:
#    this RUN must come AFTER the config-resolver/agentcore-pi COPYs or those paths are not there
#    yet.
RUN node -e "\
const fs=require('fs'),path=require('path');\
const entry=['index.js','cron-api.js','marketplace.js','grants.js','derived-role.js','agentcore-client.js','cron-runner-flag.js','approvals-routes.js','approvals-wake.js','owners.js'];\
const missing=[];\
for(const f of entry){\
  if(!fs.existsSync(f)){missing.push(f+' (entrypoint itself not copied)');continue;}\
  const src=fs.readFileSync(f,'utf8');\
  for(const m of src.matchAll(/require\\(['\\\"](\\.\\/[^'\\\"]+)['\\\"]\\)/g)){\
    const p=m[1];\
    try{require.resolve(path.resolve(process.cwd(),p));}catch{missing.push(p+' (required by '+f+')');}\
  }\
  for(const m of src.matchAll(/import\\(['\\\"](\\.\\/[^'\\\"]+)['\\\"]\\)/g)){\
    const p=m[1];\
    if(!fs.existsSync(path.resolve(process.cwd(),p)))missing.push(p+' (dynamic import in '+f+')');\
  }\
}\
if(missing.length){console.error('COPY-ALLOWLIST PREFLIGHT FAILED — add these to the Dockerfile COPY:\\n  '+[...new Set(missing)].join('\\n  '));process.exit(1);}\
console.log('copy-allowlist preflight OK ('+entry.length+' entrypoints checked, require + dynamic import)');"

# 2. LINT GATE. Fails the build if the `lint` stage did not finish clean. --mount=type=bind pulls
#    NOTHING into this layer (unlike COPY --from), so no eslint artefact ships. It also makes the
#    lint stage a build dependency — an unreferenced stage is pruned by BuildKit and would silently
#    never run. Deliberately LAST: the gate's cache key includes the lint stage, which changes on
#    every source edit, so an earlier position would invalidate the apt/npm layers every build.
RUN --mount=type=bind,from=lint,source=/lint,target=/lint \
    test -f /lint/PASSED && echo 'eslint gate OK'

USER dispatcher

ENV NODE_ENV=production
ENV PORT=9090
EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||9090)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
