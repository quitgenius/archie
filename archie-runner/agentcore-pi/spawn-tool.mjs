// Pi `sessions_spawn` tool — the schema wrapper. All logic lives in spawn-tool-core.mjs (pi-free,
// hermetic), mirroring cron-tool.mjs.

import { piAi } from './pi-runtime.mjs';
import { createDispatcherClient } from './dispatcher-client.mjs';
import { makeSpawnExecute } from './spawn-tool-core.mjs';

const T = piAi.Type;

export function createSpawnTool(deps = {}) {
  const execute = makeSpawnExecute({
    dispatcher: deps.dispatcher || createDispatcherClient(),
    log: deps.log,
  });
  return {
    name: 'sessions_spawn',
    label: 'sessions_spawn',
    // No capability of its own. A spawned session runs as the SAME scope, on the same runtime, with
    // the same derived role and the same grants — so it can do nothing the caller could not already
    // do directly. Gating it separately would imply an escalation that does not exist.
    capability: 'runtime',
    description:
      'Run a prompt in a fresh, separate session as yourself, and get its final answer back as this '
      + "tool's result. Use it to do a self-contained piece of work without spending your own "
      + 'context on the intermediate steps — a long search, a file-by-file review, a bulk summary.\n'
      + '\n'
      + 'YOU CAN RUN SEVERAL AT ONCE. To fan out, emit several sessions_spawn calls IN THE SAME '
      + 'message and they run concurrently; the total wait is the slowest one, not the sum. Calling '
      + 'one, reading its result, then calling the next runs them one after another — which is '
      + 'sometimes what you want, but it is much slower for independent work.\n'
      + '\n'
      + 'THEY SHARE YOUR FILES. A spawned session has the same workspace you do, with no locking, so '
      + 'two running at once must not write the same file — their edits will overwrite each other. '
      + 'Reading is always safe; give each one a different file if they need to write.\n'
      + '\n'
      + 'LIMITS. A spawned session cannot spawn again, so do not plan a tree of them. It starts with '
      + 'no memory of this conversation, so the prompt must be self-contained — say everything it '
      + 'needs. It is bounded by the time left in THIS turn, and if it runs out you get a message '
      + 'saying so rather than a partial answer. Every failure comes back as text for you to read '
      + 'and act on.',
    parameters: T.Object({
      prompt: T.String({
        description: 'The complete instruction for the spawned session. It shares your files but '
          + 'none of your conversation, so include every detail it needs to work unaided.',
      }),
      timeoutSeconds: T.Optional(T.Number({
        description: 'Give up on the spawned session after this long. Optional; the default is 5 '
          + 'minutes and it is always capped by the time remaining in this turn.',
      })),
    }),
    execute,
  };
}

export function buildSpawnTools(allow) {
  // Gated like every other custom tool: present only when the agent's resolved allow-set carries it.
  const allowed = allow && typeof allow.has === 'function' ? allow.has('sessions_spawn') : true;
  return allowed ? [createSpawnTool()] : [];
}
