// Conversation metadata tracker for the Slack dispatcher.
//
// Maintains an in-memory index of DM conversations per agent, backed by a
// JSON file on EFS for persistence across task restarts. Used to populate the
// "Conversations" tab in Slack App Home.

const fs = require('node:fs');
const path = require('node:path');
const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const MAX_CONVERSATIONS_PER_AGENT = 100;
const SAVE_DEBOUNCE_MS = 500;
const PAGE_SIZE = 20;
const MAX_PINNED_SHOWN = 15;
const RESUMMARIZE_AFTER = 5; // re-summarize title after this many messages
const MAX_RECENT_MESSAGES = 5;
const MAX_SNIPPET_LENGTH = 200;

// EFS path — mounted at /efs in the container, falls back to /tmp for local dev.
const DATA_DIR = process.env.CONVERSATIONS_DIR || '/efs';
const DATA_FILE = path.join(DATA_DIR, 'conversations.json');

let data = { version: 1, conversations: {} };
let saveTimer = null;
let dirty = false;

// ---------- Persistence ----------

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      data = JSON.parse(raw);
      if (!data.conversations) data.conversations = {};
    }
  } catch {
    // Missing file or corrupt JSON — start fresh
    data = { version: 1, conversations: {} };
  }
}

function save() {
  if (!dirty) return;
  dirty = false;
  try {
    // Ensure directory exists (first write after fresh EFS mount)
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

    // Atomic write: temp file + rename to avoid partial reads on crash
    const tmp = DATA_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch {
    // Will retry on next debounce
    dirty = true;
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, SAVE_DEBOUNCE_MS);
}

/** Flush immediately — call from shutdown handler. */
function saveSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = true;
  save();
}

// ---------- Summarization ----------

async function summarizeTitle(text, runtimeClient) {
  if (!runtimeClient) return null;
  try {
    const resp = await Promise.race([
      runtimeClient.send(new InvokeModelCommand({
        modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 30,
          messages: [{
            role: 'user',
            content: `Summarize this into a short conversation title (max 6 words). Reply with only the title, no quotes.\n\n${text}`,
          }],
        }),
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    const body = JSON.parse(new TextDecoder().decode(resp.body));
    const title = (body.content?.[0]?.text || '').trim();
    return title || null;
  } catch (err) {
    console.log('[conversations] summarizeTitle failed: %s', err.message);
    return null;
  }
}

// ---------- Recording ----------

function recordConversation(agentId, threadTs, { channel, userId, text }, runtimeClient) {
  if (!agentId || !threadTs) return;
  if (!data.conversations[agentId]) data.conversations[agentId] = {};

  const cleaned = stripSlackMarkup(text || '');
  const title = cleaned.slice(0, 80) || 'New conversation';

  data.conversations[agentId][threadTs] = {
    title,
    channel,
    userId,
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    messageCount: 1,
    recentMessages: [cleaned.slice(0, MAX_SNIPPET_LENGTH)],
    titleResummarized: false,
  };

  const pruned = prune(agentId);
  scheduleSave();

  // Fire-and-forget AI summarization for non-trivial messages
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (wordCount > 5) {
    summarizeTitle(cleaned, runtimeClient).then((aiTitle) => {
      const conv = (data.conversations[agentId] || {})[threadTs];
      if (aiTitle && conv) {
        conv.title = aiTitle;
        console.log('[conversations] summarized title for %s/%s: %s', agentId, threadTs, aiTitle);
        scheduleSave();
      }
    });
  }

  // The threadTs values the cap retired, for the caller to propagate as deletes. Empty in the
  // overwhelming majority of calls — only agents at the 100 cap ever return anything here.
  return pruned;
}

function updateActivity(agentId, threadTs, { channel, userId, text } = {}, runtimeClient) {
  const conv = (data.conversations[agentId] || {})[threadTs];
  if (!conv) {
    // Backfill: thread started before tracking was deployed
    if (channel && userId) {
      recordConversation(agentId, threadTs, { channel, userId, text: text || '' }, runtimeClient);
    }
    return;
  }
  conv.lastActivity = new Date().toISOString();
  conv.messageCount = (conv.messageCount || 0) + 1;

  // Track recent messages for re-summarization
  if (text) {
    const cleaned = stripSlackMarkup(text);
    if (!conv.recentMessages) conv.recentMessages = [];
    conv.recentMessages.push(cleaned.slice(0, MAX_SNIPPET_LENGTH));
    if (conv.recentMessages.length > MAX_RECENT_MESSAGES) {
      conv.recentMessages = conv.recentMessages.slice(-MAX_RECENT_MESSAGES);
    }
  }

  scheduleSave();

  // Re-summarize title after enough messages (once only)
  if (!conv.titleResummarized && conv.messageCount >= RESUMMARIZE_AFTER && conv.recentMessages?.length >= 2) {
    conv.titleResummarized = true;
    const context = conv.recentMessages.join('\n---\n');
    summarizeTitle(context, runtimeClient).then((aiTitle) => {
      const c = (data.conversations[agentId] || {})[threadTs];
      if (aiTitle && c) {
        c.title = aiTitle;
        console.log('[conversations] re-summarized title for %s/%s: %s', agentId, threadTs, aiTitle);
        scheduleSave();
      }
    });
  }
}

// ---------- Pin / Unpin ----------

function togglePin(agentId, threadTs) {
  const conv = (data.conversations[agentId] || {})[threadTs];
  if (!conv) return;
  conv.pinned = !conv.pinned;
  if (conv.pinned) {
    // Append to the end of the manual pin order; the conversation leaves
    // the recent list, so drop any custom recent-order slot it held.
    const pinned = Object.values(data.conversations[agentId] || {}).filter((c) => c.pinned && c !== conv);
    const maxOrder = pinned.reduce((max, c) => Math.max(max, typeof c.pinOrder === 'number' ? c.pinOrder : -1), -1);
    conv.pinOrder = maxOrder + 1;
    delete conv.recentOrder;
  } else {
    delete conv.pinOrder;
  }
  scheduleSave();
}

/**
 * Move a pinned conversation one slot up or down in the manual order.
 * direction is 'up' or 'down'. No-op at the ends of the list, for unpinned
 * conversations, or when the thread is unknown.
 */
function movePinned(agentId, threadTs, direction) {
  moveInList(agentId, threadTs, direction, { pinnedOnly: true, orderField: 'pinOrder' });
}

/**
 * Move a recent (unpinned) conversation one slot up or down. The recent
 * list is activity-sorted until the first move; moving anything freezes the
 * current arrangement into recentOrder (custom order). New conversations
 * still appear at the top, and resetRecentOrder restores pure recency.
 */
function moveRecent(agentId, threadTs, direction) {
  moveInList(agentId, threadTs, direction, { pinnedOnly: false, orderField: 'recentOrder' });
}

/** Dispatch a move to the right list based on the conversation's pin state. */
function moveConversation(agentId, threadTs, direction) {
  const conv = (data.conversations[agentId] || {})[threadTs];
  if (!conv) return;
  if (conv.pinned) movePinned(agentId, threadTs, direction);
  else moveRecent(agentId, threadTs, direction);
}

function moveInList(agentId, threadTs, direction, { pinnedOnly, orderField }) {
  const sorted = getConversations(agentId, {
    limit: MAX_CONVERSATIONS_PER_AGENT,
    pinnedOnly,
  }).items;
  const idx = sorted.findIndex((c) => c.threadTs === threadTs);
  if (idx === -1) return;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= sorted.length) return;

  // Normalize the order field to list positions (entries may lack it: older
  // pins, or an activity-sorted recent list being reordered for the first
  // time), then swap the two neighbours.
  const convs = data.conversations[agentId] || {};
  sorted.forEach((c, i) => {
    if (convs[c.threadTs]) convs[c.threadTs][orderField] = i;
  });
  const a = convs[sorted[idx].threadTs];
  const b = convs[sorted[targetIdx].threadTs];
  if (!a || !b) return;
  [a[orderField], b[orderField]] = [b[orderField], a[orderField]];
  scheduleSave();
}

/** True when the agent's recent list has a frozen custom order. */
function hasCustomRecentOrder(agentId) {
  return Object.values(data.conversations[agentId] || {}).some(
    (c) => !c.pinned && typeof c.recentOrder === 'number',
  );
}

/** Clear the custom order — the recent list returns to pure recency. */
function resetRecentOrder(agentId) {
  for (const conv of Object.values(data.conversations[agentId] || {})) {
    delete conv.recentOrder;
  }
  scheduleSave();
}

// ---------- Querying ----------

function getConversations(agentId, { limit = PAGE_SIZE, offset = 0, pinnedOnly } = {}) {
  const agentConvs = data.conversations[agentId] || {};
  const entries = Object.entries(agentConvs)
    .map(([threadTs, conv]) => ({ threadTs, ...conv }))
    .filter((conv) => {
      if (pinnedOnly === true) return conv.pinned;
      if (pinnedOnly === false) return !conv.pinned;
      return true; // no filter
    })
    .sort((a, b) => {
      if (pinnedOnly === true) {
        // Pinned conversations use the manual order; pins from before the
        // reorder feature (no pinOrder) sort after ordered ones.
        const ao = typeof a.pinOrder === 'number' ? a.pinOrder : Infinity;
        const bo = typeof b.pinOrder === 'number' ? b.pinOrder : Infinity;
        if (ao !== bo) return ao - bo;
      }
      if (pinnedOnly === false) {
        // Recent list: pure recency until a custom order is frozen by the
        // first move. Conversations without a recentOrder (created after
        // the freeze) sort by activity ABOVE the ordered block, so new
        // chats still surface at the top.
        const aHas = typeof a.recentOrder === 'number';
        const bHas = typeof b.recentOrder === 'number';
        if (aHas !== bHas) return aHas ? 1 : -1;
        if (aHas && bHas && a.recentOrder !== b.recentOrder) return a.recentOrder - b.recentOrder;
      }
      return new Date(b.lastActivity) - new Date(a.lastActivity);
    });
  return {
    items: entries.slice(offset, offset + limit),
    total: entries.length,
    hasMore: offset + limit < entries.length,
  };
}

/**
 * Case-insensitive search over conversation titles and recent message
 * snippets. Returns newest-first matches.
 */
function searchConversations(agentId, query, { limit = 20 } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { items: [], total: 0 };
  const agentConvs = data.conversations[agentId] || {};
  const matches = Object.entries(agentConvs)
    .map(([threadTs, conv]) => ({ threadTs, ...conv }))
    .filter((conv) =>
      (conv.title || '').toLowerCase().includes(q) ||
      (conv.recentMessages || []).some((m) => (m || '').toLowerCase().includes(q))
    )
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  return {
    items: matches.slice(0, limit),
    total: matches.length,
  };
}

// ---------- Block Kit ----------

// Slack rejects views with more than 100 blocks (each row below is 2 blocks),
// so the tab paginates with fixed-size pages instead of growing the list \u2014
// a "show more" that appends can never display all conversations.
function buildConversationsTab(agentId, teamId, { page = 0 } = {}) {
  const blocks = [];

  const pinned = getConversations(agentId, {
    limit: MAX_CONVERSATIONS_PER_AGENT,
    pinnedOnly: true,
  });
  const recentTotal = getConversations(agentId, { limit: 0, pinnedOnly: false }).total;

  // Empty state
  if (pinned.items.length === 0 && recentTotal === 0) {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: 'Conversations' } });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No conversations yet. Send a DM to get started!_' },
    });
    return blocks;
  }

  // Clamp the requested page so stale buttons (or the legacy grow-style
  // values) can never build an out-of-range or oversized view.
  const totalPages = Math.max(1, Math.ceil(recentTotal / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const offset = currentPage * PAGE_SIZE;
  const { items: recentItems, hasMore } =
    getConversations(agentId, { limit: PAGE_SIZE, offset, pinnedOnly: false });

  // --- Search ---
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '\ud83d\udd0d Search Conversations' },
      action_id: 'conversations_search_open',
    }],
  });
  blocks.push({ type: 'divider' });

  // --- Pinned section (capped so it can't blow the view's block budget) ---
  if (pinned.items.length > 0) {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: '\ud83d\udccc Pinned' } });
    const shown = pinned.items.slice(0, MAX_PINNED_SHOWN);
    shown.forEach((conv, i) => {
      blocks.push(...buildConversationRow(conv, teamId, true, {
        isFirst: i === 0,
        isLast: i === shown.length - 1 && pinned.items.length <= MAX_PINNED_SHOWN,
      }));
    });
    if (pinned.items.length > MAX_PINNED_SHOWN) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_+${pinned.items.length - MAX_PINNED_SHOWN} more pinned \u2014 unpin some to see them here._`,
        }],
      });
    }
    blocks.push({ type: 'divider' });
  }

  // --- Recent section ---
  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'Recent Conversations' } });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `Your recent DM conversations with *${agentId}*.` },
  });
  blocks.push({ type: 'divider' });

  if (hasCustomRecentOrder(agentId)) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '_Custom order — new conversations still appear at the top._',
      }],
    });
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Reset to recent order' },
        action_id: 'conversations_reset_order',
      }],
    });
  }

  if (recentItems.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_All conversations are pinned._' },
    });
  } else {
    recentItems.forEach((conv, i) => {
      blocks.push(...buildConversationRow(conv, teamId, false, {
        isFirst: offset + i === 0,
        isLast: offset + i === recentTotal - 1,
      }));
    });
  }

  if (totalPages > 1) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Showing ${offset + 1}\u2013${offset + recentItems.length} of ${recentTotal}`,
      }],
    });
    const pagerButtons = [];
    if (currentPage > 0) {
      pagerButtons.push({
        type: 'button',
        text: { type: 'plain_text', text: '\u25c0 Newer' },
        action_id: 'conversations_page_prev',
        value: String(currentPage - 1),
      });
    }
    if (hasMore) {
      pagerButtons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Older \u25b6' },
        action_id: 'conversations_page_next',
        value: String(currentPage + 1),
      });
    }
    if (pagerButtons.length > 0) {
      blocks.push({ type: 'actions', elements: pagerButtons });
    }
  }

  return blocks;
}

function buildConversationRow(conv, teamId, isPinned, { isFirst = false, isLast = false } = {}) {
  const ago = relativeTime(conv.lastActivity);
  const started = relativeTime(conv.startedAt);
  const msgLabel = conv.messageCount === 1 ? '1 message' : `${conv.messageCount} messages`;
  const threadLink = buildThreadLink(teamId, conv.channel, conv.threadTs);

  const elements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Open' },
      url: threadLink,
      action_id: 'conversations_open_thread',
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: isPinned ? 'Unpin' : '\ud83d\udccc Pin' },
      action_id: 'conversations_toggle_pin',
      value: conv.threadTs,
    },
  ];

  // Both lists support manual ordering. Pinned order is always manual;
  // the recent list freezes into a custom order on the first move (see
  // moveRecent). Arrows are hidden at the ends of each list.
  if (!isFirst) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '\u2b06\ufe0f' },
      action_id: 'conversations_move_up',
      value: conv.threadTs,
    });
  }
  if (!isLast) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '\u2b07\ufe0f' },
      action_id: 'conversations_move_down',
      value: conv.threadTs,
    });
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeMarkdown(conv.title)}*\n${msgLabel}  \u00b7  started ${started}  \u00b7  last active ${ago}`,
      },
    },
    { type: 'actions', elements },
  ];
}

// ---------- Search modals ----------

function buildConversationSearchModal() {
  return {
    type: 'modal',
    callback_id: 'conversations_search_submit',
    title: { type: 'plain_text', text: 'Search Conversations' },
    submit: { type: 'plain_text', text: 'Search' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'search_block',
        element: {
          type: 'plain_text_input',
          action_id: 'search_query',
          placeholder: { type: 'plain_text', text: 'e.g. quarterly report, twitter, standup\u2026' },
        },
        label: { type: 'plain_text', text: 'Search titles and recent messages' },
      },
    ],
  };
}

function buildConversationSearchResultsModal(query, agentId, teamId) {
  const { items, total } = searchConversations(agentId, query, { limit: 20 });
  const blocks = [];

  if (items.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `No conversations found for "${escapeMarkdown(query)}".` },
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Found ${total} conversation${total === 1 ? '' : 's'} for "${escapeMarkdown(query)}"${total > items.length ? ` \u2014 showing the ${items.length} most recent` : ''}`,
      }],
    });
    for (const conv of items) {
      const ago = relativeTime(conv.lastActivity);
      const msgLabel = conv.messageCount === 1 ? '1 message' : `${conv.messageCount} messages`;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeMarkdown(conv.title)}*${conv.pinned ? ' \ud83d\udccc' : ''}\n${msgLabel}  \u00b7  last active ${ago}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open' },
          url: buildThreadLink(teamId, conv.channel, conv.threadTs),
          action_id: 'conversations_open_thread',
        },
      });
    }
  }

  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Search Results' },
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

// ---------- Helpers ----------

/**
 * Drop the oldest unpinned conversations once an agent passes the cap.
 *
 * RETURNS THE DROPPED threadTs LIST. It used to return nothing, which was fine while EFS was the
 * only store — the whole file was rewritten anyway, so a deletion needed no announcement. With a
 * per-item store there is no whole-file rewrite to carry it, so a silent delete would leave the
 * retired conversation in DynamoDB forever and it would reappear at cutover. This is live, not
 * theoretical: 12 prod agents sit at the cap and one turns over 46 conversations a week.
 */
function prune(agentId) {
  const convs = data.conversations[agentId];
  if (!convs) return [];
  const keys = Object.keys(convs);
  if (keys.length <= MAX_CONVERSATIONS_PER_AGENT) return [];

  // Sort by lastActivity ascending, drop oldest
  const sorted = keys.sort((a, b) =>
    new Date(convs[a].lastActivity) - new Date(convs[b].lastActivity)
  );
  const toDrop = sorted
    .filter((key) => !convs[key].pinned) // never prune pinned conversations
    .slice(0, keys.length - MAX_CONVERSATIONS_PER_AGENT);
  for (const key of toDrop) {
    delete convs[key];
  }
  return toDrop;
}

function stripSlackMarkup(text) {
  return text
    .replace(/<@[A-Z0-9]+>/g, '')     // user mentions
    .replace(/<#[A-Z0-9]+\|?[^>]*>/g, '') // channel mentions
    .replace(/<(https?:\/\/[^|>]+)\|?[^>]*>/g, '$1') // links
    .replace(/[*_~`]/g, '')            // formatting
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim();
}

function escapeMarkdown(text) {
  // Escape characters that would be interpreted as Slack mrkdwn
  return (text || '').replace(/[*_~`]/g, '');
}

function buildThreadLink(teamId, channel, threadTs) {
  // slack://channel opens in the desktop app; falls back to browser if app isn't installed
  return `slack://channel?team=${teamId}&id=${channel}&message=${threadTs}`;
}

function relativeTime(isoStr) {
  if (!isoStr) return 'unknown';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(isoStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

module.exports = {
  load,
  save,
  saveSync,
  recordConversation,
  updateActivity,
  getConversations,
  searchConversations,
  togglePin,
  movePinned,
  moveRecent,
  moveConversation,
  hasCustomRecentOrder,
  resetRecentOrder,
  buildConversationsTab,
  buildConversationSearchModal,
  buildConversationSearchResultsModal,
};
