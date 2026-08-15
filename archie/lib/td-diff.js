'use strict';

// The equivalence gate: does archie's composition match what Terraform actually registered?
//
// GATEWAY-OWNERSHIP-PLAN.md §6 step 5 and §7. This is the ONLY evidence that moving ownership is
// safe. Phase D removes `aws_ecs_task_definition.dispatcher` from Terraform, after which the
// composed definition is what runs — and if it differs from Terraform's in any field, the difference
// arrives as a live behaviour change on a service that has already stopped its only task
// (desired_count 1, minimum_healthy_percent 0, ~94s measured). A clean diff here, taken against the
// real deployed revision, is what turns that from a hope into a check.
//
// It is also §7's standing mitigation, not a one-off migration tool. `terraform plan` used to
// validate the task definition on every apply; after Phase D nothing does, so this diff is what a
// composition change is reviewed against before it is registered.
//
// THREE RULES:
//
// 1. ENVIRONMENT IS COMPARED BY KEY, NEVER BY INDEX. ECS preserves and returns the order it was
//    given, Terraform's list is in authoring order, and archie's is sorted — so an index comparison
//    reports 35 differences on two identical environments.
//
// 2. THE IMAGE IS NOT COMPARED. archie owns which image runs and always has; a differing tag is the
//    normal state between a deploy and the next one, not a finding.
//
// 3. FIELDS AWS ADDS ARE NOT DIFFERENCES. `DescribeTaskDefinition` echoes back defaults that were
//    never sent — `cpu: 0` and `volumesFrom: []` and `systemControls: []` on the container,
//    `hostPort` mirroring `containerPort`, `placementConstraints: []` on the definition. Reporting
//    those would drown the real ones, which is the failure mode that makes a gate ceremonial.

const IGNORED_CONTAINER_FIELDS = new Set(['image', 'cpu', 'volumesFrom', 'systemControls', 'memory', 'memoryReservation']);
const IGNORED_TD_FIELDS = new Set([
  'taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities',
  'registeredAt', 'registeredBy', 'deregisteredAt', 'placementConstraints', 'tags',
]);

/**
 * @param composed  the RegisterTaskDefinition input archie built
 * @param deployed  a DescribeTaskDefinition `taskDefinition`
 * @returns { equivalent, environment: {missing,extra,changed}, fields: [{field,composed,deployed}] }
 */
function diffTaskDefinition(composed, deployed) {
  const cc = pickContainer(composed);
  const dc = pickContainer(deployed);

  const environment = diffEnvironment(cc.environment || [], dc.environment || []);
  const secrets = diffSecrets(cc.secrets || [], dc.secrets || []);
  const fields = [];

  for (const field of ['family', 'networkMode', 'cpu', 'memory', 'executionRoleArn', 'taskRoleArn']) {
    if (IGNORED_TD_FIELDS.has(field)) continue;
    compare(fields, field, composed[field], deployed[field]);
  }
  compare(fields, 'requiresCompatibilities', sorted(composed.requiresCompatibilities), sorted(deployed.requiresCompatibilities));
  compare(fields, 'volumes', normaliseVolumes(composed.volumes), normaliseVolumes(deployed.volumes));

  for (const field of ['name', 'essential', 'mountPoints', 'logConfiguration', 'healthCheck']) {
    if (IGNORED_CONTAINER_FIELDS.has(field)) continue;
    compare(fields, `container.${field}`, cc[field], dc[field]);
  }
  compare(fields, 'container.portMappings', normalisePorts(cc.portMappings), normalisePorts(dc.portMappings));

  const equivalent = fields.length === 0
    && environment.missing.length === 0 && environment.extra.length === 0 && environment.changed.length === 0
    && secrets.missing.length === 0 && secrets.extra.length === 0 && secrets.changed.length === 0;

  return { equivalent, environment, secrets, fields };
}

/**
 * By KEY. `missing` is in the deployed definition but not the composition — the dangerous
 * direction, because it is a variable the running container has and the composed one would not.
 */
function diffEnvironment(composedList, deployedList) {
  const a = mapOf(composedList, 'name', 'value');
  const b = mapOf(deployedList, 'name', 'value');
  return {
    missing: Object.keys(b).filter((k) => !(k in a)).sort().map((key) => ({ key, deployed: b[key] })),
    extra: Object.keys(a).filter((k) => !(k in b)).sort().map((key) => ({ key, composed: a[key] })),
    changed: Object.keys(a).filter((k) => k in b && a[k] !== b[k]).sort()
      .map((key) => ({ key, composed: a[key], deployed: b[key] })),
  };
}

/** Same shape, on `valueFrom`. A secret pointing at a different ARN is a silent credential swap. */
function diffSecrets(composedList, deployedList) {
  const a = mapOf(composedList, 'name', 'valueFrom');
  const b = mapOf(deployedList, 'name', 'valueFrom');
  return {
    missing: Object.keys(b).filter((k) => !(k in a)).sort().map((key) => ({ key, deployed: b[key] })),
    extra: Object.keys(a).filter((k) => !(k in b)).sort().map((key) => ({ key, composed: a[key] })),
    changed: Object.keys(a).filter((k) => k in b && a[k] !== b[k]).sort()
      .map((key) => ({ key, composed: a[key], deployed: b[key] })),
  };
}

const mapOf = (list, keyField, valueField) => Object.fromEntries(
  (list || []).map((e) => [e[keyField], e[valueField]]),
);

const pickContainer = (td) => {
  const containers = (td && td.containerDefinitions) || [];
  return containers.find((c) => /dispatcher|archie/i.test(c.name)) || containers[0] || {};
};

const sorted = (v) => (Array.isArray(v) ? v.slice().sort() : v);

/**
 * `hostPort` is echoed back equal to `containerPort` in awsvpc mode whether or not it was sent, so
 * comparing it reports a difference on two identical mappings.
 */
const normalisePorts = (list) => (list || []).map((p) => ({
  containerPort: p.containerPort, protocol: p.protocol || 'tcp',
}));

/** `rootDirectory` defaults to '/' and `transitEncryptionPort: 0` means "unset". */
const normaliseVolumes = (list) => (list || []).map((v) => {
  const efs = v.efsVolumeConfiguration;
  if (!efs) return { name: v.name };
  return {
    name: v.name,
    fileSystemId: efs.fileSystemId,
    rootDirectory: efs.rootDirectory || '/',
    transitEncryption: efs.transitEncryption,
    accessPointId: (efs.authorizationConfig || {}).accessPointId,
    iam: (efs.authorizationConfig || {}).iam,
  };
});

function compare(out, field, composed, deployed) {
  const a = JSON.stringify(composed === undefined ? null : composed);
  const b = JSON.stringify(deployed === undefined ? null : deployed);
  if (a !== b) out.push({ field, composed: composed ?? null, deployed: deployed ?? null });
}

/** Human rendering, shared by `gateway compose` and the deploy dry-run. */
function renderDiff(diff) {
  if (diff.equivalent) return 'equivalent  the composed task definition matches the deployed one exactly (image aside)';
  const lines = [];
  for (const e of diff.environment.missing) lines.push(`env -       ${e.key}=${e.deployed}  (deployed has it; the composition does NOT)`);
  for (const e of diff.environment.extra) lines.push(`env +       ${e.key}=${e.composed}`);
  for (const e of diff.environment.changed) lines.push(`env ~       ${e.key}: ${e.deployed} -> ${e.composed}`);
  for (const e of diff.secrets.missing) lines.push(`secret -    ${e.key}  (deployed has it; the composition does NOT)`);
  for (const e of diff.secrets.extra) lines.push(`secret +    ${e.key}`);
  for (const e of diff.secrets.changed) lines.push(`secret ~    ${e.key}: ${e.deployed} -> ${e.composed}`);
  for (const f of diff.fields) {
    lines.push(`field ~     ${f.field}: ${JSON.stringify(f.deployed)} -> ${JSON.stringify(f.composed)}`);
  }
  return lines.join('\n');
}

module.exports = { diffTaskDefinition, diffEnvironment, diffSecrets, renderDiff };
