// PiPluginHost — the OPTIONAL OpenClaw→Pi compat layer (#14b, plan §2.2–2.4).
//
// Runs an OpenClaw plugin's `register(api)` against a synthesized `OpenClawPluginApi`
// facade, collects the tools + lifecycle hooks it registers, and turns them into Pi
// inputs:
//   - customTools[]        → passed to createAgentSession (raw JSON-Schema params pass
//                            through unchanged — P0 proven). execute() is wrapped to run
//                            before/after_tool_call handlers (Pi's native tool_call hook
//                            is block-only, so param mutation MUST happen in the wrapper).
//   - extensionFactory(pi) → wires the prompt/lifecycle hooks onto Pi events:
//                            before_prompt_build → pi.on("context"); agent_end → agent_end;
//                            session_start/end → session_start / session_shutdown.
//
// This module has NO Pi import — it operates on the `pi` object Pi hands the factory and
// emits plain tool defs. Pi-native plugins skip it entirely (they ARE Pi extensions).
//
// Session ctx (agentId/sessionKey/agentDir) is fixed for a Pi session → tool factories
// resolve once. Per-turn ctx (runId/sender) lives in a mutable `turnCtx` the adapter
// updates each /invocations; hook + wrapper read it at call time.

import path from 'node:path';

const noop = () => {};

// Plain-text (NOT JSON-wrapped) so the plugin's own formatted log strings pass through
// VERBATIM — several parity legs assert on exact plugin log contracts (e.g. @connector
// greps /connector-session-plugin: agent="bdd-connector" ready/). JSON.stringify would
// escape the inner quotes (agent=\"…\") and break those needles. Prefix keeps it
// greppable + attributable to the compat layer.
function makeLogger(pluginId, sink = console) {
  const line = (level, args) => {
    try { sink[level === 'debug' ? 'log' : level](`[compat:${pluginId}] ${args.map(String).join(' ')}`); } catch { /* logging must never throw */ }
  };
  return { info: (...a) => line('info', a), warn: (...a) => line('warn', a), error: (...a) => line('error', a), debug: (...a) => line('debug', a) };
}

// Build the `api` facade + collect registrations for ONE plugin entry.
function runRegister(entry, { pluginConfig, sessionCtx, config, logSink }) {
  const tools = [];   // { toolOrFactory, isFactory }
  const hooks = {};   // hookName -> [handler]
  const addHook = (name, handler) => { (hooks[name] ??= []).push(handler); };

  const unsupported = (method) => (...args) => {
    logSink.debug?.(`api.${method}() is a no-op under Pi compat`);
    return undefined;
  };

  const api = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: 'pi-compat',
    registrationMode: 'full',
    config: config || {},
    pluginConfig,
    runtime: {},
    logger: makeLogger(entry.id, logSink),
    resolvePath: (p) => path.resolve(sessionCtx.agentDir || sessionCtx.workspaceDir || process.cwd(), String(p)),
    registerTool: (toolOrFactory) => { tools.push({ toolOrFactory, isFactory: typeof toolOrFactory === 'function' }); },
    registerHook: (events, handler) => { for (const e of [].concat(events)) addHook(e, handler); },
    on: (hookName, handler) => addHook(hookName, handler),
    // Surfaces our 3 target plugins never use under Pi — safe no-ops (logged once at debug).
    registerCommand: unsupported('registerCommand'),
    registerService: unsupported('registerService'),
    registerProvider: unsupported('registerProvider'),
    registerChannel: unsupported('registerChannel'),
    registerHttpRoute: unsupported('registerHttpRoute'),
    registerGatewayMethod: unsupported('registerGatewayMethod'),
    registerCli: unsupported('registerCli'),
    registerContextEngine: unsupported('registerContextEngine'),
    registerMemoryPromptSection: unsupported('registerMemoryPromptSection'),
    onConversationBindingResolved: noop,
  };

  entry.register(api);
  return { tools, hooks };
}

// Resolve a registered tool (object or factory) into concrete tool def(s).
function resolveTools({ toolOrFactory, isFactory }, factoryCtx) {
  const out = isFactory ? toolOrFactory(factoryCtx) : toolOrFactory;
  return (Array.isArray(out) ? out : [out]).filter(Boolean);
}

// Wrap a tool's execute() with the plugin's before_tool_call (param mutation) +
// after_tool_call (result mutation) handlers, reading per-turn ctx at call time.
function wrapExecute(tool, hooks, ctxProvider, log = console) {
  const before = hooks.before_tool_call || [];
  const after = hooks.after_tool_call || [];
  if (!before.length && !after.length) return tool;
  const orig = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, args, ...rest) {
      const ctx = ctxProvider();
      let params = args || {};
      // A failing before/after hook must not crash the tool call — isolate it.
      for (const h of before) {
        try { const r = await h({ toolName: tool.name, params }, ctx); if (r && r.params) params = r.params; }
        catch (e) { log.warn?.(`before_tool_call hook failed (isolated): ${String(e && e.message)}`); }
      }
      let result = await orig(toolCallId, params, ...rest);
      for (const h of after) {
        try { const r = await h({ toolName: tool.name, params, result }, ctx); if (r && r.result) result = r.result; }
        catch (e) { log.warn?.(`after_tool_call hook failed (isolated): ${String(e && e.message)}`); }
      }
      return result;
    },
  };
}

// Fold an OpenClaw before_prompt_build result into a single injected text block.
// (context hook only mutates `messages`; prompt-cache split via before_agent_start is a
// later optimisation — plan §2.4. Behaviourally the model SEES all injected context.)
function injectedTextFrom(result) {
  if (!result) return '';
  const parts = [result.prependSystemContext, result.systemPrompt, result.prependContext, result.appendSystemContext]
    .filter((s) => typeof s === 'string' && s.trim());
  return parts.join('\n\n');
}

function appendToLastUser(messages, text) {
  const msgs = messages.slice();
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      const m = { ...msgs[i] };
      const add = `\n\n${text}`;
      if (typeof m.content === 'string') m.content = m.content + add;
      else if (Array.isArray(m.content)) m.content = [...m.content, { type: 'text', text: add }];
      msgs[i] = m;
      return msgs;
    }
  }
  return msgs;
}

/**
 * Build Pi inputs from a set of OpenClaw plugin entries.
 * @param entries [{ entry, pluginConfig }]  entry = definePluginEntry(...) output
 * @param opts    { sessionCtx:{agentId,sessionKey,agentDir,workspaceDir}, config, turnCtx, logSink }
 *                turnCtx is a mutable object (e.g. {runId}) the adapter updates per turn.
 * @returns { customTools, extensionFactory, plugins }
 */
/**
 * Run each plugin's `register()` WITHOUT resolving its tools, and wait for any asynchronous
 * discovery it kicked off. Boot-time pre-warm — see the race this exists to close.
 *
 * THE RACE (measured 2026-08-12): connector-session-plugin's `register()` starts
 * `discoverAndCache()` and returns immediately; `buildCompatPlugins` then resolves tool factories
 * SYNCHRONOUSLY. Discovery lands ~460ms later, so on a first session build the cache is empty and
 * the plugin contributes only its early tools. Under OpenClaw that was harmless — one long-lived
 * gateway process, so only the very first message could lose, and it resolved tools per message
 * anyway. Under Pi every AgentCore session is its own microVM, so EVERY session build is the first
 * and the race ALWAYS loses: 66/66 sampled session builds contained zero `mcp_connector__*` tools,
 * while `mcp_connector_plugin_health` cheerfully reported `ready, toolCount: 6`.
 *
 * Registering here is safe to do twice: the plugin guards its eager discovery with a
 * `globalThis.__connectorSessionPluginInited` flag, so the per-session register is a no-op for
 * discovery purposes once this has run.
 *
 * Readiness is read from the plugin's own in-flight map. That is a deliberate coupling to one
 * plugin's internals — we own both sides, and the alternative (a readiness contract in the SDK)
 * is a bigger change than the bug warrants. It degrades safely: an unknown shape just means no
 * promises to await.
 */
export async function prewarmCompatPlugins(entries, opts = {}) {
  const { sessionCtx = {}, config = {}, logSink = console, timeoutMs = 15000 } = opts;
  const registered = [];
  for (const { entry, pluginConfig } of entries) {
    try {
      runRegister(entry, { pluginConfig, sessionCtx, config, logSink });
      registered.push(entry.id);
    } catch (e) {
      // Same isolation rule as buildCompatPlugins: one plugin failing must not stop boot.
      makeLogger(entry.id, logSink).warn?.(`prewarm register failed (isolated): ${String(e && e.message || e)}`);
    }
  }
  const inflight = globalThis.__connectorSessionPluginDiscovering;
  const pending = inflight && typeof inflight.values === 'function' ? [...inflight.values()] : [];
  if (!pending.length) return { registered, awaited: 0, timedOut: false };

  let timedOut = false;
  // BOUNDED. A hung discovery must delay boot, not prevent it — the agent still serves Slack
  // without Connector, which is strictly better than not booting.
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => { setTimeout(() => { timedOut = true; resolve(); }, timeoutMs).unref?.(); }),
  ]);
  return { registered, awaited: pending.length, timedOut };
}

export function buildCompatPlugins(entries, opts = {}) {
  const { sessionCtx = {}, config = {}, turnCtx = {}, logSink = console } = opts;
  const ctxProvider = () => ({
    agentId: sessionCtx.agentId,
    sessionKey: sessionCtx.sessionKey,
    agentDir: sessionCtx.agentDir,
    runId: turnCtx.runId,
    trigger: turnCtx.trigger,
    // Per-sender routing (mcp-auth senderUserMap). Under AgentCore a Pi session == one
    // conversation == one sender, so binding the sender when tools are resolved at
    // session-build is sound — provided the adapter seeds turnCtx.sender BEFORE getSession.
    requesterSenderId: turnCtx.sender ?? sessionCtx.requesterSenderId ?? undefined,
  });

  const customTools = [];
  // Hooks are tagged with their plugin id so a failing one can be isolated + attributed.
  const allHooks = { before_prompt_build: [], agent_end: [], session_start: [], session_end: [] };
  const loaded = [];

  // PLUGIN ISOLATION: a plugin that fails to load/discover (e.g. connector with no API key
  // → 401) must NOT stop the agent booting or break the turn — only that plugin's tools
  // degrade. So register + tool-resolve + every hook run under try/catch; a failure logs
  // and disables just that plugin's contribution.
  for (const { entry, pluginConfig } of entries) {
    const log = makeLogger(entry.id, logSink);
    let reg;
    try {
      reg = runRegister(entry, { pluginConfig, sessionCtx, config, logSink });
    } catch (e) {
      log.warn?.(`register failed (isolated — plugin disabled): ${String(e && e.message || e)}`);
      loaded.push({ id: entry.id, tools: 0, hooks: [], error: String(e && e.message || e) });
      continue;
    }
    const { tools, hooks } = reg;
    let toolCount = 0;
    for (const t0 of tools) {
      try {
        for (const t of resolveTools(t0, ctxProvider())) {
          if (t && typeof t.execute === 'function' && t.name) { customTools.push(wrapExecute(t, hooks, ctxProvider, log)); toolCount += 1; }
        }
      } catch (e) { log.warn?.(`tool resolve failed (isolated): ${String(e && e.message)}`); }
    }
    for (const name of ['before_prompt_build', 'agent_end', 'session_start', 'session_end']) {
      if (hooks[name]) allHooks[name].push(...hooks[name].map((fn) => ({ fn, id: entry.id })));
    }
    loaded.push({ id: entry.id, tools: toolCount, hooks: Object.keys(hooks) });
  }

  // Run a set of tagged hooks, isolating each: a throwing plugin hook (e.g. connector's
  // before_prompt_build hitting a 401) is logged + skipped, never breaking the turn.
  const runHooks = async (list, arg, apply) => {
    for (const { fn, id } of list) {
      try { const r = await fn(arg, ctxProvider()); if (apply) apply(r); }
      catch (e) { makeLogger(id, logSink).warn?.(`hook failed (isolated): ${String(e && e.message)}`); }
    }
  };

  const extensionFactory = (pi) => {
    if (allHooks.before_prompt_build.length) {
      pi.on('context', async (event) => {
        let messages = event.messages;
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
        await runHooks(allHooks.before_prompt_build, { prompt, messages }, (r) => {
          const text = injectedTextFrom(r);
          if (text) messages = appendToLastUser(messages, text);
        });
        return { messages };
      });
    }
    if (allHooks.agent_end.length) {
      pi.on('agent_end', async (event) => { await runHooks(allHooks.agent_end, event); });
    }
    if (allHooks.session_start.length) {
      pi.on('session_start', async (event) => { await runHooks(allHooks.session_start, event); });
    }
    if (allHooks.session_end.length) {
      pi.on('session_shutdown', async (event) => { await runHooks(allHooks.session_end, event); });
    }
  };

  return { customTools, extensionFactory, plugins: loaded };
}
