// Custom MCP server registration — OPEN-SOURCE BUILD.
//
// This is a stub. The real module is a REST client for a third-party connector platform: it
// registers a user-supplied MCP server as a toolkit, creates and resolves auth configs, mints
// OAuth connect links, polls connection status, and resolves the per-agent API key that all of
// that is done under.
//
// Only the VALIDATORS survive here, because they are generic — slug and name shapes, URL checks,
// auth-scheme construction — and the App Home renderer in marketplace.js calls them to validate a
// submission before it would ever reach a vendor. Everything that would talk to a remote service
// refuses instead, with the reason.
//
// Keep this export surface if you implement against your own connector platform; marketplace.js and
// index.js both import from here by name.

const NOT_AVAILABLE = 'not-available-in-open-source-build';

// Kept so callers that read it for display still get a string rather than undefined. It points
// nowhere in this build.
const CONNECTOR_BASE = 'https://connector-platform.example/api/v3';
const DEFAULT_API_KEY_TEMPLATE = 'Bearer {token}';

// Shapes, not vendor rules: a slug is lowercase alphanumeric with _ and -, a display name is a
// short human string. Both are enforced before anything leaves the gateway.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const NAME_RE = /^[\w .,'()\-/&]{2,64}$/;

/** `<agent>_<name>` folded to the slug alphabet, upper-cased — the toolkit identity. */
function sanitizeSlug(agentId, name) {
  const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return [norm(agentId), norm(name)].filter(Boolean).join('_').slice(0, 64);
}

/** http(s) only, host required, no credentials embedded, no fragment. */
function validateAppUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { ok: false, error: 'Enter a full https:// URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Only http(s) URLs are supported' };
  if (!u.hostname) return { ok: false, error: 'URL has no host' };
  if (u.username || u.password) return { ok: false, error: 'Do not put credentials in the URL' };
  return { ok: true, url: u.toString() };
}

function validateName(raw) {
  const s = String(raw ?? '').trim();
  return NAME_RE.test(s)
    ? { ok: true, name: s }
    : { ok: false, error: 'Use 2–64 characters: letters, numbers, spaces, . , \' ( ) - / &' };
}

/** The auth-scheme object a toolkit registration would carry. Pure shape; nothing is sent. */
function buildAuthSchemes({ authMode = 'none', headerTemplate, discoveryUrl } = {}) {
  if (authMode === 'header') return [{ mode: 'BEARER_TOKEN', template: headerTemplate || DEFAULT_API_KEY_TEMPLATE }];
  if (authMode === 'oauth2') return [{ mode: 'OAUTH2', ...(discoveryUrl ? { discoveryUrl } : {}) }];
  return [{ mode: 'NO_AUTH' }];
}

// --- everything that would reach a remote service ---------------------------
const refuse = (op) => { const e = new Error(`${op}: ${NOT_AVAILABLE}`); e.code = NOT_AVAILABLE; throw e; };

async function registerCustomToolkit() { return refuse('registerCustomToolkit'); }
async function syncCustomToolkit() { return refuse('syncCustomToolkit'); }
async function deleteCustomToolkit() { return refuse('deleteCustomToolkit'); }
async function listAuthConfigs() { return []; }
async function getAuthConfigId() { return null; }
async function ensureAuthConfig() { return refuse('ensureAuthConfig'); }
async function createConnectLink() { return refuse('createConnectLink'); }
async function getStatus() { return { connected: false, reason: NOT_AVAILABLE }; }
async function discoverOAuthDiscoveryUrl() { return null; }
async function resolveConnectorKey() { return null; }

module.exports = {
  CONNECTOR_BASE, DEFAULT_API_KEY_TEMPLATE, SLUG_RE, NAME_RE,
  sanitizeSlug, validateAppUrl, validateName, buildAuthSchemes,
  registerCustomToolkit, syncCustomToolkit, deleteCustomToolkit,
  listAuthConfigs, getAuthConfigId, ensureAuthConfig, createConnectLink, getStatus,
  discoverOAuthDiscoveryUrl, resolveConnectorKey,
};
