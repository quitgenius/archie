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
    // Its own capability, so the Tools tab can offer it WITHOUT offering arbitrary shell. Not an
    // escalation — a child is the same scope with the same grants — but it is the thing an operator
    // wants to switch on and off, and `runtime` is too coarse to be that switch. See
    // tool-declarations.mjs.
    capability: 'spawn',
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

export function buildSpawnTools() {
  // ALWAYS BUILT — deliberately unlike the tools gated on the resolved allow-set.
  //
  // The allow-set is a CONFIG surface: changing it means a change to the agent's config repo and a
  // hydrate. That made enabling sessions_spawn a two-place operation (a config token AND a grant),
  // with only the grant visible in App Home — so the Tools tab could show the tool and still not be
  // able to switch it on, which is worse than not showing it.
  //
  // Building it unconditionally is safe because the capability is default-deny: with no `spawn`
  // grant, applyToolFilter drops it from the model's surface and the PEP refuses a call that arrives
  // anyway. So the tab's toggle IS the control, and it is the only control.
  return [createSpawnTool()];
}
