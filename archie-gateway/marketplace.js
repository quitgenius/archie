// Skills Marketplace + Connected Apps — OPEN-SOURCE BUILD.
//
// This is a stub. The real module integrates a third-party connector platform: it reads a skill
// catalogue and per-agent install state out of DynamoDB, brokers OAuth connections to external
// apps, registers custom MCP servers, and renders all of that into Slack's App Home.
//
// None of that ships here. That integration is specific to one vendor and to the deployment it was
// written for, so the open-source build keeps the SHAPE and drops the contents: every export below
// exists with its real signature, the App Home tabs render, and they render empty.
//
// What that means in practice:
//   - the tab strip is real — Conversations / Skills / Connected Apps / Models / Jobs / Files /
//     Tools / Owners all resolve and paint
//   - every list is empty, and says so
//   - every mutation (install, connect, set model, add MCP server) is a no-op that reports why
//   - the pure helpers — text fitting, slug parsing, URL and name validation — are real, because
//     they are generic and the rest of the gateway calls them
//
// The gateway, the agent runtime, the isolation model and the Cedar policy layer are NOT stubs.
// Only the connector marketplace is. Swap this file for an implementation against whatever
// connector platform you use, keeping the export surface, and App Home fills in.

const NOT_AVAILABLE = 'not-available-in-open-source-build';

// A no-op result shape shared by every write path. Callers in index.js check `ok` and surface
// `reason`, so an empty build degrades visibly rather than silently.
const unavailable = (action) => ({ ok: false, reason: NOT_AVAILABLE, action });

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const header = (text) => ({ type: 'header', text: { type: 'plain_text', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

/** The empty state every tab shares — says what is missing and why, rather than looking broken. */
const emptyState = (what) => [
  section(`_No ${what} are configured._`),
  context('This is the open-source build. The connector integration is not included — '
    + 'see `marketplace.js` for the export surface to implement against your own.'),
];

// --- module state ------------------------------------------------------------
// The real module caches a catalogue and install map loaded from DynamoDB. Here they stay empty,
// but the accessors exist because index.js and the App Home renderers read them every paint.
let catalog = {};
let installs = {};
let _derivedRoleHook = null;

// --- constants (real: index.js matches on these action ids) -----------------
const AGENT_SELECT_ACTION = 'agent_select';
const SLACK_CONFIRM_TEXT_MAX = 300;
const OWNER_ADD_SELECT = 'owners_add_select';
const OWNER_ADD_ACTION = 'owners_add';

// --- generic helpers (real implementations — no vendor semantics) -----------

/** Slack caps confirmation-dialog text; truncate on a word boundary where possible. */
function fitConfirmText(text) {
  const s = String(text ?? '');
  if (s.length <= SLACK_CONFIRM_TEXT_MAX) return s;
  const cut = s.slice(0, SLACK_CONFIRM_TEXT_MAX - 1);
  const sp = cut.lastIndexOf(' ');
  return `${sp > SLACK_CONFIRM_TEXT_MAX * 0.6 ? cut.slice(0, sp) : cut}…`;
}

/** Trim, strip Slack's angle-bracket link wrapping, and drop anything that is not an http(s) URL. */
function sanitizeUrlInput(raw) {
  let s = String(raw ?? '').trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).split('|')[0];
  return /^https?:\/\//i.test(s) ? s : '';
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const NAME_RE = /^[\w .,'()\-/&]{2,64}$/;

/** Stable slug for a custom MCP server, scoped to the agent that registered it. */
function customMcpSlug(agentId, name) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${norm(agentId)}__${norm(name)}`.slice(0, 64);
}

/** Inverse of customMcpSlug: `<agent>__<name>` → its parts, or null when it does not parse. */
function parseCustomMcpSlugValue(value) {
  const s = String(value ?? '');
  const i = s.indexOf('__');
  if (i <= 0 || i === s.length - 2) return null;
  return { agentId: s.slice(0, i), name: s.slice(i + 2) };
}

/** Shape-only validation of the App Home "add MCP server" modal submission. */
function validateCustomMcpSubmission({ name, appUrl, authMode, headerTemplate, discoveryUrl } = {}) {
  const errors = {};
  if (!NAME_RE.test(String(name ?? ''))) errors.name = 'Use 2–64 characters: letters, numbers, spaces, . , \' ( ) - / &';
  if (!sanitizeUrlInput(appUrl)) errors.appUrl = 'Enter a full https:// URL';
  if (authMode && !['none', 'header', 'oauth2'].includes(authMode)) errors.authMode = 'Unknown auth mode';
  if (authMode === 'header' && !String(headerTemplate ?? '').includes('{token}')) {
    errors.headerTemplate = 'Header template must contain {token}';
  }
  if (authMode === 'oauth2' && discoveryUrl && !sanitizeUrlInput(discoveryUrl)) {
    errors.discoveryUrl = 'Enter a full https:// discovery URL';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

function ownersAddBlockId(agentId) { return `owners_add__${agentId}`; }

function formatApprovalDestination(destination) {
  if (!destination) return 'an unknown destination';
  const { kind, id, name } = destination;
  if (kind === 'channel') return name ? `#${name}` : `<#${id}>`;
  if (kind === 'user') return name ? `@${name}` : `<@${id}>`;
  return String(name || id || 'an unknown destination');
}

function approvalActionPhrase(toolSlug) {
  const s = String(toolSlug ?? '').replace(/^[a-z0-9]+__/i, '').replace(/[_-]+/g, ' ').trim();
  return s ? s.toLowerCase() : 'run this tool';
}

// --- data loading (empty in this build) -------------------------------------

async function loadMarketplaceDataFromDdb(_doc, _tableName, _deps = {}) {
  catalog = {};
  installs = {};
  return { catalog, installs, skipped: NOT_AVAILABLE };
}

async function fetchAgentMarketplace(_doc, _tableName, agentId) {
  return { agentId, installs: {}, connectors: {}, models: {}, customMcp: {} };
}

function getCatalog() { return catalog; }
function getInstalls() { return installs; }
function getCustomMcpEntries() { return []; }

async function fetchConnectorToolkits() { return []; }
function getCachedConnectorToolkits() { return []; }
async function fetchBedrockModels() { return []; }
function getCachedBedrockModels() { return []; }

function setDerivedRoleHook(fn) { _derivedRoleHook = fn; }
async function _reconcileSkillGrant() { return { ok: false, reason: NOT_AVAILABLE, hook: Boolean(_derivedRoleHook) }; }

// --- App Home rendering ------------------------------------------------------

function buildAgentOptionGroups(entries = []) {
  return [{
    label: { type: 'plain_text', text: 'Agents' },
    options: (entries || []).slice(0, 100).map((e) => ({
      text: { type: 'plain_text', text: String(e.label || e.id) },
      value: String(e.id),
    })),
  }];
}

function buildAgentSelectorBlocks(agentId, _options = {}) {
  return [
    {
      type: 'actions',
      elements: [{
        type: 'external_select',
        action_id: AGENT_SELECT_ACTION,
        placeholder: { type: 'plain_text', text: 'Select an agent' },
        ...(agentId ? { initial_option: { text: { type: 'plain_text', text: agentId }, value: agentId } } : {}),
      }],
    },
    { type: 'divider' },
  ];
}

const TABS = [
  ['conversations', 'Conversations'], ['skills', 'Skills'], ['connectors', 'Connected Apps'],
  ['models', 'Models'], ['jobs', 'Jobs'], ['files', 'Files'], ['tools', 'Tools'], ['owners', 'Owners'],
];

function buildHomeView(agentId, activeTab = 'skills', options = {}) {
  const blocks = [];
  if (!agentId) {
    blocks.push(header('Archie'));
    blocks.push(section('No agent is configured for you yet.'));
    return { type: 'home', blocks };
  }
  blocks.push(...buildAgentSelectorBlocks(agentId, options));
  blocks.push({
    type: 'actions',
    elements: TABS.map(([id, label]) => ({
      type: 'button',
      text: { type: 'plain_text', text: label },
      action_id: `marketplace_tab_${id}`,
      ...(activeTab === id ? { style: 'primary' } : {}),
    })),
  });
  blocks.push({ type: 'divider' });
  const tab = {
    skills: () => buildSkillsTab(agentId, options.marketplace),
    connectors: () => buildConnectorsTab(agentId, null, options.marketplace),
    models: () => buildModelsTab(agentId, options.marketplace),
    jobs: () => buildJobsTab(agentId, options.jobs, options.cronRunner),
    files: () => buildFilesTab(agentId, options.files),
    tools: () => buildToolsTab(agentId, options.tools),
    owners: () => buildOwnersTab(agentId, options.owners, { notice: options.ownersNotice }),
  }[activeTab];
  blocks.push(...(tab ? tab() : [section('_Nothing here yet._')]));
  return { type: 'home', blocks };
}

const tabBuilder = (title, what) => (agentId) => [header(title), section(`Agent: *${agentId}*`), ...emptyState(what)];

const buildSkillsTab = tabBuilder('Skills Marketplace', 'skills');
const buildConnectorsTab = (agentId) => [header('Connected Apps'), section(`Agent: *${agentId}*`), ...emptyState('connected apps')];
const buildModelsTab = tabBuilder('Models', 'models');
const buildJobsTab = tabBuilder('Scheduled Jobs', 'jobs');
const buildFilesTab = tabBuilder('Files', 'files');
const buildToolsTab = tabBuilder('Tools', 'tools');
function buildOwnersTab(agentId, _owners, { notice = null } = {}) {
  return [header('Owners'), section(`Agent: *${agentId}*`), ...(notice ? [context(notice)] : []), ...emptyState('owners')];
}

function buildApprovalsBlocks() { return emptyState('pending approvals'); }

const modal = (title, body) => ({
  type: 'modal',
  title: { type: 'plain_text', text: title },
  close: { type: 'plain_text', text: 'Close' },
  blocks: [section(body), ...emptyState('details')],
});

const buildDetailModal = () => modal('Skill', 'Skill details are not available in this build.');
const buildConnectorDetailModal = () => modal('Connected App', 'Connector details are not available in this build.');
const buildModelDetailModal = () => modal('Model', 'Model details are not available in this build.');
const buildJobDetailModal = () => modal('Job', 'Job details are not available in this build.');
const buildJobDeleteConfirmModal = () => modal('Delete job', 'Job deletion is not available in this build.');
const buildConnectorInstallingModal = () => modal('Connecting', 'Connecting apps is not available in this build.');
const buildConnectorSearchModal = () => modal('Find an app', 'App search is not available in this build.');
const buildConnectorSearchResultsModal = () => modal('Results', 'App search is not available in this build.');
const buildCustomMcpAddModal = () => modal('Add MCP server', 'Custom MCP servers are not available in this build.');
const buildCustomMcpDetailModal = () => modal('MCP server', 'Custom MCP servers are not available in this build.');
function buildCustomMcpSectionBlocks() { return emptyState('custom MCP servers'); }

// --- writes (no-ops) ---------------------------------------------------------

async function installSkill() { return unavailable('installSkill'); }
async function uninstallSkill() { return unavailable('uninstallSkill'); }
async function connectApp() { return unavailable('connectApp'); }
async function disconnectApp() { return unavailable('disconnectApp'); }
async function addCustomMcp() { return unavailable('addCustomMcp'); }
async function touchCustomMcp() { return unavailable('touchCustomMcp'); }
async function removeCustomMcp() { return unavailable('removeCustomMcp'); }
async function setModel() { return unavailable('setModel'); }

module.exports = {
  fitConfirmText,
  SLACK_CONFIRM_TEXT_MAX,
  loadMarketplaceDataFromDdb,
  fetchAgentMarketplace,
  getCatalog,
  getInstalls,
  fetchConnectorToolkits,
  getCachedConnectorToolkits,
  fetchBedrockModels,
  getCachedBedrockModels,
  buildHomeView,
  buildAgentSelectorBlocks,
  buildAgentOptionGroups,
  formatApprovalDestination,
  approvalActionPhrase,
  buildApprovalsBlocks,
  buildOwnersTab,
  OWNER_ADD_SELECT,
  OWNER_ADD_ACTION,
  ownersAddBlockId,
  AGENT_SELECT_ACTION,
  buildSkillsTab,
  buildConnectorsTab,
  buildModelsTab,
  buildJobsTab,
  buildFilesTab,
  buildToolsTab,
  buildDetailModal,
  buildConnectorDetailModal,
  buildModelDetailModal,
  buildJobDetailModal,
  buildJobDeleteConfirmModal,
  buildConnectorInstallingModal,
  buildConnectorSearchModal,
  buildConnectorSearchResultsModal,
  installSkill,
  uninstallSkill,
  connectApp,
  disconnectApp,
  addCustomMcp,
  touchCustomMcp,
  removeCustomMcp,
  setModel,
  sanitizeUrlInput,
  customMcpSlug,
  parseCustomMcpSlugValue,
  getCustomMcpEntries,
  validateCustomMcpSubmission,
  buildCustomMcpAddModal,
  buildCustomMcpDetailModal,
  buildCustomMcpSectionBlocks,
  _reconcileSkillGrant,
  setDerivedRoleHook,
  _setCatalogForTest: (c) => { catalog = c; },
  SLUG_RE,
  NAME_RE,
};
