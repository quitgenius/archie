// Type surface for the local plugin-sdk shim (see plugin-entry.mjs).
//
// Reproduces the *minimal* slice of OpenClaw's `plugin-sdk/plugin-entry` types that the
// Archie plugins actually consume — nothing more. Deliberately self-contained: it imports
// NOTHING from OpenClaw and NOTHING from Pi, so the plugins carry no such dependency purely
// for these types. The one genuine Pi type the plugins need — the agent tool shape — is
// imported directly from `@mariozechner/pi-agent-core` at its use sites (src/tool-cache.ts),
// which is exactly the tool type OpenClaw itself re-exported (`AnyAgentTool = AgentTool`).

/** Structured logger handed to a plugin's `register(api)`. */
export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Context passed to a tool factory (`registerTool`) and to lifecycle hooks (`on`).
 * Session-scoped fields (agentId/agentDir/sessionKey) are fixed for the life of a Pi
 * session; per-turn fields (runId/requesterSenderId) are refreshed each invocation.
 * All optional — the compat host populates whatever it knows for the current turn.
 */
export interface PluginToolContext {
  agentId?: string;
  agentDir?: string;
  runId?: string;
  sessionKey?: string;
  requesterSenderId?: string;
  /**
   * What started this turn — `'cron'` for a scheduled fire, otherwise the host's own label.
   *
   * The compat host has always passed this (`openclaw-compat/plugin-host.mjs`), but it was not
   * declared here, so plugins inferred cron-ness by parsing the session key instead. That parsing is
   * host-specific and it broke: OpenClaw keys mark cron with a `:cron:` SEGMENT, while the archie
   * dispatcher's are `slack:thread:<channel>:cron-<jobId>`, where the marker is part of a synthetic
   * THREAD ID and the key deliberately stays four segments. A plugin reading this field needs to know
   * neither grammar.
   */
  trigger?: string;
}

/** Event object passed to `before_tool_call` / `before_prompt_build` hooks. */
export interface PluginHookEvent {
  toolName: string;
  params: Record<string, unknown>;
  [key: string]: unknown;
}

/** The `api` facade a plugin receives in `register(api)`. */
export interface PluginApi {
  /** Raw plugin config block (plugins parse/validate it themselves). */
  pluginConfig: unknown;
  logger: PluginLogger;
  /** Register a tool factory; return value may be a single tool, an array, or a promise. */
  registerTool(factory: (ctx: PluginToolContext) => unknown): void;
  /** Subscribe to a lifecycle hook (e.g. "before_tool_call", "before_prompt_build"). */
  on(event: string, handler: (event: PluginHookEvent, ctx: PluginToolContext) => unknown): void;
}

export type PluginConfigSchema = Record<string, unknown>;

export interface DefinePluginEntryOptions {
  id: string;
  name: string;
  description: string;
  kind?: string;
  configSchema?: PluginConfigSchema | (() => PluginConfigSchema);
  register: (api: PluginApi) => void;
}

export interface DefinedPluginEntry {
  id: string;
  name: string;
  description: string;
  kind?: string;
  configSchema: PluginConfigSchema;
  register: (api: PluginApi) => void;
}

export declare const emptyPluginConfigSchema: PluginConfigSchema;

export declare function definePluginEntry(options: DefinePluginEntryOptions): DefinedPluginEntry;
