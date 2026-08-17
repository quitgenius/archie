// Local plugin-sdk shim for the Archie plugins (formerly `openclaw/plugin-sdk/plugin-entry`).
//
// The plugins were authored against OpenClaw's plugin SDK, but the AgentCore image is
// Pi-only and carries NO OpenClaw dist. This module reproduces the only two RUNTIME
// exports the plugins consume — `definePluginEntry` (a trivial normalizer) and
// `emptyPluginConfigSchema` — so the plugins bundle and run with zero OpenClaw
// dependency. The plugin *types* they use come straight from `@mariozechner/pi-agent-core`
// (see plugin-entry.d.mts); OpenClaw is fully removed from every package.json.
//
// The plugin entry object is loaded by agentcore-pi/openclaw-compat/plugin-host.mjs,
// which synthesizes the `api` facade passed to `register(api)`.

export const emptyPluginConfigSchema = { type: 'object', properties: {} };

export function definePluginEntry({ id, name, description, kind, configSchema, register }) {
  if (typeof register !== 'function') throw new Error(`definePluginEntry(${id}): register must be a function`);
  return {
    id,
    name,
    description,
    kind,
    configSchema: typeof configSchema === 'function' ? configSchema() : (configSchema || emptyPluginConfigSchema),
    register,
  };
}
