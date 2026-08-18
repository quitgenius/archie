// §8.6 capability-on-tool: the factories that BUILD our adapter-native tools.
//
// The {toolName → capability} map lives in tool-declarations.mjs (data, zero imports) rather than
// being derived by CONSTRUCTING every tool to read two fields off the objects. What that changed:
//
//   · Nothing that only wants the MAP loads the Pi harness. Every tool module does
//     `const T = piAi.Type` at module scope, and pi-runtime.mjs top-level-awaits the Pi packages, so
//     the old `toolCapabilities()` pulled in the whole agent runtime — which is why the dispatcher
//     could not use it, and why config-resolver/providers.mjs existed as a hand-written mirror until
//     this change let the real modules ship (that file is now deleted).
//   · The hand-maintained `ALL_CAPS` allow-set is gone. It existed solely to force construction, and
//     had to list allow-set TOKENS and capability names side by side because the factories gate on
//     the former. tool-declarations.permissiveAllowSet() derives both from the declarations.
//
// allCustomTools() stays, and is now TEST-ONLY: constructing the real tools is how we prove the
// declarations match reality (tool-registry.test.mjs asserts both directions). Runtime tool building
// happens per session in pi-adapter with that agent's real allow-set, never through here.

import { buildMemoryTools } from './memory-tool.mjs';
import { buildKnowledgeTools } from './knowledge-tools.mjs';
import { buildKnowledgeWriteTools } from './knowledge-write-tools.mjs';
import { buildCronTools } from './cron-tool.mjs';
import { buildOtelTools } from './otel-tool.mjs';
import { buildDatadogTools } from './datadog-tool.mjs';
import { buildCloudwatchLogsTools } from './cloudwatch-logs-tool.mjs';
import { buildPerson79b333SecretsTools } from './aws-person79b333-secrets-tool.mjs';
import { buildAirflowTools } from './airflow-tool.mjs';
import { buildAwsReadonlyTools } from './aws-readonly-tool.mjs';
import { createSandboxProbeTool } from './sandbox-probe-tool.mjs';
import { CUSTOM_TOOLS, permissiveAllowSet } from './tool-declarations.mjs';

/**
 * Every custom tool, actually built — with a permissive allow-set (+ the probe directly, bypassing
 * its env flag) so the set is complete regardless of grants or flags.
 *
 * FOR TESTS. Importing this module imports the whole tool tree and therefore Pi; if you only need
 * names or capabilities, import tool-declarations.mjs directly.
 */
export function allCustomTools(cwd = '/tmp') {
  const allow = permissiveAllowSet();
  return [
    ...buildMemoryTools(allow, cwd),
    // Config-gated rather than allow-gated (see buildKnowledgeTools): pass a stand-in apiUrl/bankId so
    // the closure check sees all four. At runtime pi-adapter supplies the real org bank.
    ...buildKnowledgeTools({ apiUrl: 'https://hindsight.invalid', bankId: 'closure-check' }),
    // Same invalid-but-present config: both knowledge factories are CONFIG-gated, so the closure check has
    // to supply something or the tools are simply absent and the declarations look like drift.
    ...buildKnowledgeWriteTools({ apiUrl: 'https://hindsight.invalid', bankId: 'closure-check' }),
    ...buildCronTools(allow),
    ...buildOtelTools(),
    ...buildDatadogTools(allow),
    ...buildCloudwatchLogsTools(allow),
    ...buildPerson79b333SecretsTools(allow),
    ...buildAirflowTools(allow),
    ...buildAwsReadonlyTools(allow),
    createSandboxProbeTool(),
  ];
}

// NO toolCapabilities() ANY MORE. It used to derive {name → capability} by constructing every tool;
// once the declarations became data it was a one-line passthrough to CUSTOM_TOOLS, and every caller
// was a test. They import tool-declarations.mjs directly now — which also means the permission tests
// no longer load the Pi harness to read a constant. The runtime never used it: pi-adapter builds its
// own toolCaps from the tools it actually built for that session (pi-adapter.mjs:1051), because a
// session's surface depends on that agent's allow-set, not on the full declared set.
