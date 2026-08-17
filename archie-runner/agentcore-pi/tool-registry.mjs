// §8.6 capability-on-tool: the fleet-wide {toolName → capability} map, derived from the tools
// themselves (each tool declares `capability`). This is the single source that replaces the old
// hand-written capabilityOf switch. The adapter builds its PER-SESSION resolver from the tools it
// actually built for that agent (see pi-adapter); this registry enumerates ALL custom tools with a
// permissive allow-set (grant-gating decides RUNTIME availability, not the capability DECLARATION),
// and is used by tests + as a static reference.

import { buildMemoryTools } from './memory-tool.mjs';
import { buildCronTools } from './cron-tool.mjs';
import { buildOtelTools } from './otel-tool.mjs';
import { buildDatadogTools } from './datadog-tool.mjs';
import { buildCloudwatchLogsTools } from './cloudwatch-logs-tool.mjs';
import { buildPerson79b333SecretsTools } from './aws-person79b333-secrets-tool.mjs';
import { buildAirflowTools } from './airflow-tool.mjs';
import { buildAwsReadonlyTools } from './aws-readonly-tool.mjs';
import { createSandboxProbeTool } from './sandbox-probe-tool.mjs';

// Permissive allow-set so every build*Tools yields its tools. NB build gates check the raw
// allow-set TOKENS (e.g. buildMemoryTools → 'memory_search'/'memory_get'), which are NOT always the
// capability the tool declares ('memory') — so include both flavors.
const ALL_CAPS = new Set([
  'memory', 'memory_search', 'memory_get', 'cron', 'otel', 'datadog', 'cloudwatch-logs',
  'aws-person79b333-secrets', 'airflow', 'aws-readonly', 'sandbox-probe', 'fs.read', 'fs.write', 'runtime',
]);

// Every custom tool, built once with a permissive allow-set (+ the probe directly, bypassing its
// env flag) so the map is complete regardless of grants/flags.
export function allCustomTools(cwd = '/tmp') {
  return [
    ...buildMemoryTools(ALL_CAPS, cwd),
    ...buildCronTools(ALL_CAPS),
    ...buildOtelTools(),
    ...buildDatadogTools(ALL_CAPS),
    ...buildCloudwatchLogsTools(ALL_CAPS),
    ...buildPerson79b333SecretsTools(ALL_CAPS),
    ...buildAirflowTools(ALL_CAPS),
    ...buildAwsReadonlyTools(ALL_CAPS),
    createSandboxProbeTool(),
  ];
}

// {toolName → capability} from the tools' own declarations.
export function toolCapabilities(cwd = '/tmp') {
  return Object.fromEntries(
    allCustomTools(cwd).filter((t) => t && t.name && t.capability).map((t) => [t.name, t.capability]),
  );
}
