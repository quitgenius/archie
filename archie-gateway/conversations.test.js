'use strict';

// Tests for the Conversations App Home tab. The hard constraint throughout:
// Slack rejects any view with more than 100 blocks, so every page the tab
// builds must stay under that budget regardless of how much data exists.

// Only used for AI title summarization, which tests skip (null client)
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({ InvokeModelCommand: class {} }));

const conversations = require('./conversations');

const AGENT = 'test-agent';
const TEAM = 'T012345';

// The module keeps state in a module-level object; build it through the
// public recording API so tests exercise the same paths production does.
function seedConversations({ recent = 0, pinned = 0 } = {}) {
  for (let i = 0; i < recent + pinned; i++) {
    const threadTs = `171000000${String(i).padStart(4, '0')}.000100`;
    conversations.recordConversation(
      AGENT,
      threadTs,
      { channel: 'D0AAA111', userId: 'U0BBB222', text: `conversation number ${i}` },
      null, // no bedrock client — skips AI summarization
    );
    if (i < pinned) conversations.togglePin(AGENT, threadTs);
  }
}

// recordConversation prunes to MAX_CONVERSATIONS_PER_AGENT (100), so seed
// counts here stay within that to keep arithmetic predictable.
const PAGE_SIZE = 20;

beforeEach(() => {
  // Reset module state between tests by re-requiring a fresh instance
  delete require.cache[require.resolve('./conversations')];
  Object.assign(conversations, require('./conversations'));
});

describe('buildConversationsTab pagination', () => {
  it('shows the first page with an Older button and no Newer button', () => {
    seedConversations({ recent: 50 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page: 0 });

    const actionIds = blocks
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e) => e.action_id));
    expect(actionIds).toContain('conversations_page_next');
    expect(actionIds).not.toContain('conversations_page_prev');

    const rows = blocks.filter((b) => b.text?.text?.startsWith('*conversation'));
    expect(rows).toHaveLength(PAGE_SIZE);
  });

  it('shows both pager buttons on a middle page', () => {
    seedConversations({ recent: 50 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page: 1 });

    const actionIds = blocks
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e) => e.action_id));
    expect(actionIds).toContain('conversations_page_prev');
    expect(actionIds).toContain('conversations_page_next');
  });

  it('shows only a Newer button on the last page', () => {
    seedConversations({ recent: 50 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page: 2 });

    const actionIds = blocks
      .filter((b) => b.type === 'actions')
      .flatMap((b) => b.elements.map((e) => e.action_id));
    expect(actionIds).toContain('conversations_page_prev');
    expect(actionIds).not.toContain('conversations_page_next');

    const rows = blocks.filter((b) => b.text?.text?.startsWith('*conversation'));
    expect(rows).toHaveLength(10); // 50 conversations → pages of 20, 20, 10
  });

  it('clamps out-of-range pages (stale/legacy button values) to the last page', () => {
    seedConversations({ recent: 50 });
    // Legacy grow-style buttons carried showCount values like "60"
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page: 60 });

    const context = blocks.find((b) => b.type === 'context');
    expect(context.elements[0].text).toContain('41–50 of 50');
  });

  it('includes a range indicator', () => {
    seedConversations({ recent: 50 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page: 1 });

    const context = blocks.find((b) => b.type === 'context');
    expect(context.elements[0].text).toContain('21–40 of 50');
  });

  it('renders the empty state without pager buttons', () => {
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, {});
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(blocks)).toContain('No conversations yet');
  });
});

describe('buildConversationsTab block budget', () => {
  it('never exceeds Slack view limit on any page at max data volume', () => {
    // Worst case the store can hold: 100 conversations, 30 of them pinned
    seedConversations({ recent: 70, pinned: 30 });

    for (let page = 0; page < 10; page++) {
      const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page });
      // Home view adds its own chrome (tab bar + divider = 2 blocks)
      expect(blocks.length).toBeLessThanOrEqual(98);
    }
  });

  it('caps the pinned section and says how many are hidden', () => {
    seedConversations({ recent: 5, pinned: 20 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page: 0 });

    const pinRows = blocks.filter(
      (b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'conversations_toggle_pin' && e.text.text.includes('Unpin')),
    );
    expect(pinRows).toHaveLength(15); // MAX_PINNED_SHOWN
    expect(JSON.stringify(blocks)).toContain('+5 more pinned');
  });
});

describe('searchConversations', () => {
  it('matches titles case-insensitively', () => {
    seedConversations({ recent: 5 });
    const { items, total } = conversations.searchConversations(AGENT, 'CONVERSATION NUMBER 3');
    expect(total).toBe(1);
    expect(items[0].title).toContain('conversation number 3');
  });

  it('matches recent message snippets', () => {
    conversations.recordConversation(AGENT, '1710000001.000100', {
      channel: 'D0AAA111', userId: 'U0BBB222', text: 'first message',
    }, null);
    conversations.updateActivity(AGENT, '1710000001.000100', {
      channel: 'D0AAA111', userId: 'U0BBB222', text: 'follow-up about quarterly report',
    }, null);

    const { total } = conversations.searchConversations(AGENT, 'quarterly report');
    expect(total).toBe(1);
  });

  it('returns empty results for blank or non-matching queries', () => {
    seedConversations({ recent: 3 });
    expect(conversations.searchConversations(AGENT, '').total).toBe(0);
    expect(conversations.searchConversations(AGENT, '   ').total).toBe(0);
    expect(conversations.searchConversations(AGENT, 'zzz-no-match').total).toBe(0);
  });

  it('caps items at the limit but reports the full total', () => {
    seedConversations({ recent: 30 });
    const { items, total } = conversations.searchConversations(AGENT, 'conversation', { limit: 10 });
    expect(items).toHaveLength(10);
    expect(total).toBe(30);
  });
});

describe('buildConversationSearchResultsModal', () => {
  it('lists matches with Open buttons', () => {
    seedConversations({ recent: 3 });
    const modal = conversations.buildConversationSearchResultsModal('conversation number 1', AGENT, TEAM);
    expect(modal.type).toBe('modal');
    const sections = modal.blocks.filter((b) => b.type === 'section');
    expect(sections).toHaveLength(1);
    expect(sections[0].accessory.action_id).toBe('conversations_open_thread');
    expect(sections[0].accessory.url).toContain(TEAM);
  });

  it('shows an empty state when nothing matches', () => {
    seedConversations({ recent: 2 });
    const modal = conversations.buildConversationSearchResultsModal('nothing here', AGENT, TEAM);
    expect(modal.blocks[0].text.text).toContain('No conversations found');
  });
});

describe('pinned conversation ordering', () => {
  // Pinned order after seeding: seeds pin in creation order, so pinOrder
  // follows the seed index (0, 1, 2, ...).
  function pinnedTitles() {
    return conversations
      .getConversations(AGENT, { limit: 100, pinnedOnly: true })
      .items.map((c) => c.title);
  }

  it('keeps manual pin order stable regardless of activity', () => {
    seedConversations({ recent: 0, pinned: 3 });
    // Touch the last-pinned conversation — with time-based sorting it would
    // jump to the top; manual ordering must keep it in place.
    conversations.updateActivity(AGENT, '1710000000000.000100', {}, null);
    expect(pinnedTitles()).toEqual([
      'conversation number 0',
      'conversation number 1',
      'conversation number 2',
    ]);
  });

  it('moves a pinned conversation up and down', () => {
    seedConversations({ recent: 0, pinned: 3 });
    conversations.movePinned(AGENT, '1710000000002.000100', 'up');
    expect(pinnedTitles()).toEqual([
      'conversation number 0',
      'conversation number 2',
      'conversation number 1',
    ]);
    conversations.movePinned(AGENT, '1710000000002.000100', 'down');
    expect(pinnedTitles()).toEqual([
      'conversation number 0',
      'conversation number 1',
      'conversation number 2',
    ]);
  });

  it('is a no-op at the ends of the list and for unknown threads', () => {
    seedConversations({ recent: 0, pinned: 2 });
    conversations.movePinned(AGENT, '1710000000000.000100', 'up');   // already first
    conversations.movePinned(AGENT, '1710000000001.000100', 'down'); // already last
    conversations.movePinned(AGENT, 'does-not-exist', 'up');
    expect(pinnedTitles()).toEqual(['conversation number 0', 'conversation number 1']);
  });

  it('renders move buttons only where movement is possible', () => {
    seedConversations({ recent: 0, pinned: 3 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, {});
    const actionRows = blocks.filter(
      (b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'conversations_toggle_pin'),
    );
    expect(actionRows).toHaveLength(3);
    const idsPerRow = actionRows.map((r) => r.elements.map((e) => e.action_id));
    expect(idsPerRow[0]).not.toContain('conversations_move_up');
    expect(idsPerRow[0]).toContain('conversations_move_down');
    expect(idsPerRow[1]).toContain('conversations_move_up');
    expect(idsPerRow[1]).toContain('conversations_move_down');
    expect(idsPerRow[2]).toContain('conversations_move_up');
    expect(idsPerRow[2]).not.toContain('conversations_move_down');
  });

  it('unpinning clears the manual order slot', () => {
    seedConversations({ recent: 0, pinned: 3 });
    conversations.togglePin(AGENT, '1710000000001.000100'); // unpin the middle one
    expect(pinnedTitles()).toEqual(['conversation number 0', 'conversation number 2']);
    // Re-pinning appends to the end
    conversations.togglePin(AGENT, '1710000000001.000100');
    expect(pinnedTitles()).toEqual([
      'conversation number 0',
      'conversation number 2',
      'conversation number 1',
    ]);
  });
});

describe('recent conversation ordering', () => {
  function recentTitles() {
    return conversations
      .getConversations(AGENT, { limit: 100, pinnedOnly: false })
      .items.map((c) => c.title);
  }

  // Seeds record 0..N in order, each with a later timestamp? No — all seeds
  // share the same wall-clock instant, so activity sort is insertion-stable.
  // Use updateActivity to force distinct recency where a test depends on it.

  it('stays purely recency-sorted until the first move', () => {
    seedConversations({ recent: 3 });
    conversations.updateActivity(AGENT, '1710000000000.000100', {}, null); // bump oldest
    expect(recentTitles()[0]).toBe('conversation number 0');
    expect(conversations.hasCustomRecentOrder(AGENT)).toBe(false);
  });

  it('freezes the displayed order on first move and swaps the neighbours', () => {
    seedConversations({ recent: 3 });
    const before = recentTitles();
    const second = '1710000000001.000100';
    conversations.moveRecent(AGENT, second, 'up');

    const after = recentTitles();
    expect(conversations.hasCustomRecentOrder(AGENT)).toBe(true);
    // The moved item swapped with the row above it; everything else kept its place
    const idxBefore = before.indexOf('conversation number 1');
    expect(after.indexOf('conversation number 1')).toBe(idxBefore - 1);

    // New activity no longer reshuffles the frozen order
    const last = after[after.length - 1];
    const lastTs = conversations
      .getConversations(AGENT, { limit: 100, pinnedOnly: false })
      .items[after.length - 1].threadTs;
    conversations.updateActivity(AGENT, lastTs, {}, null);
    expect(recentTitles()[after.length - 1]).toBe(last);
  });

  it('new conversations appear above the frozen order', () => {
    seedConversations({ recent: 2 });
    // Freeze by moving whatever is currently LAST — naming a threadTs risks naming the item already
    // at index 0, where 'up' is a no-op. This test used to do that, and on the no-op path it froze
    // nothing and then passed (or failed) purely on millisecond recency between the seed and the new
    // conversation. Either way it was not exercising the frozen order in its own name.
    const lastTs = conversations.getConversations(AGENT, { limit: 100, pinnedOnly: false })
      .items.at(-1).threadTs;
    conversations.moveRecent(AGENT, lastTs, 'up');
    expect(conversations.hasCustomRecentOrder(AGENT)).toBe(true);
    conversations.recordConversation(AGENT, '1710000000099.000100', {
      channel: 'D0AAA111', userId: 'U0BBB222', text: 'brand new one',
    }, null);
    expect(recentTitles()[0]).toBe('brand new one');
  });

  it('resetRecentOrder restores recency sorting', () => {
    seedConversations({ recent: 3 });
    // Move whatever is CURRENTLY last, rather than naming a threadTs and hoping it is movable.
    //
    // `recordConversation` stamps lastActivity at millisecond resolution, so three seeds written in
    // a tight loop may or may not tie. Tied → the stable sort falls back to insertion order
    // [0,1,2]; untied → recency descending gives [2,1,0]. The item at index 0 differs between those
    // two, and moving the index-0 item 'up' is a no-op that freezes NOTHING. This test named seed #2
    // and so passed only on the tied outcome — a real flake that read as spooky rather than as the
    // test asserting against an order it had never established.
    const lastTs = conversations.getConversations(AGENT, { limit: 100, pinnedOnly: false })
      .items.at(-1).threadTs;
    conversations.moveRecent(AGENT, lastTs, 'up');
    expect(conversations.hasCustomRecentOrder(AGENT)).toBe(true);
    conversations.resetRecentOrder(AGENT);
    expect(conversations.hasCustomRecentOrder(AGENT)).toBe(false);
    conversations.updateActivity(AGENT, '1710000000000.000100', {}, null);
    expect(recentTitles()[0]).toBe('conversation number 0');
  });

  it('moveConversation dispatches by pin state', () => {
    seedConversations({ recent: 2, pinned: 2 });
    conversations.moveConversation(AGENT, '1710000000001.000100', 'up'); // pinned (seeded pins are 0,1)
    const pinnedTitles = conversations
      .getConversations(AGENT, { limit: 100, pinnedOnly: true })
      .items.map((c) => c.title);
    expect(pinnedTitles[0]).toBe('conversation number 1');
    expect(conversations.hasCustomRecentOrder(AGENT)).toBe(false); // recent untouched
  });

  it('pinning a custom-ordered conversation clears its recent slot', () => {
    seedConversations({ recent: 3 });
    conversations.moveRecent(AGENT, '1710000000001.000100', 'up');
    conversations.togglePin(AGENT, '1710000000001.000100');
    const conv = conversations
      .getConversations(AGENT, { limit: 100, pinnedOnly: true })
      .items.find((c) => c.title === 'conversation number 1');
    expect(conv.recentOrder).toBeUndefined();
  });

  it('renders arrows on recent rows and hides them at the ends', () => {
    seedConversations({ recent: 3 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, {});
    const actionRows = blocks.filter(
      (b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'conversations_toggle_pin'),
    );
    expect(actionRows).toHaveLength(3);
    const idsPerRow = actionRows.map((r) => r.elements.map((e) => e.action_id));
    expect(idsPerRow[0]).not.toContain('conversations_move_up');
    expect(idsPerRow[0]).toContain('conversations_move_down');
    expect(idsPerRow[2]).toContain('conversations_move_up');
    expect(idsPerRow[2]).not.toContain('conversations_move_down');
  });

  it('shows the reset button only when a custom order exists', () => {
    seedConversations({ recent: 2 });
    let blocks = conversations.buildConversationsTab(AGENT, TEAM, {});
    let ids = blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
    expect(ids).not.toContain('conversations_reset_order');

    // Move the SECOND item of the current order, resolved at runtime — not a hardcoded
    // threadTs. recordConversation stamps lastActivity at millisecond resolution, so whether
    // the seeded pair ties (stable sort keeps insertion order) or straddles a ms boundary
    // (later entry sorts first) decides which thread is at index 0. Moving index 0 'up' is a
    // documented no-op, which silently made this assertion wall-clock dependent.
    const second = conversations.getConversations(AGENT, { pinnedOnly: false }).items[1].threadTs;
    conversations.moveRecent(AGENT, second, 'up');
    blocks = conversations.buildConversationsTab(AGENT, TEAM, {});
    ids = blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
    expect(ids).toContain('conversations_reset_order');
  });

  it('keeps arrows page-aware: first row of page 2 still has an up arrow', () => {
    seedConversations({ recent: 25 });
    const blocks = conversations.buildConversationsTab(AGENT, TEAM, { page: 1 });
    const actionRows = blocks.filter(
      (b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'conversations_toggle_pin'),
    );
    const firstRowIds = actionRows[0].elements.map((e) => e.action_id);
    expect(firstRowIds).toContain('conversations_move_up');
    const lastRowIds = actionRows[actionRows.length - 1].elements.map((e) => e.action_id);
    expect(lastRowIds).not.toContain('conversations_move_down'); // 25th of 25
  });
});

// The delete-propagation contract that the DynamoDB store depends on. prune() used to delete
// silently, which was harmless while the whole EFS file was rewritten on every save — the deletion
// travelled for free. A per-item store has no whole-file rewrite to carry it, so an unannounced
// delete leaves the conversation in DynamoDB forever and it reappears at cutover. Live, not
// theoretical: 12 prod agents sit at the cap and one turns over 46 conversations a week.
describe('prune reports what it retired', () => {
  it('returns nothing while the agent is under the cap', () => {
    const dropped = conversations.recordConversation(AGENT, '1780000000.000001',
      { channel: 'D1', userId: 'U1', text: 'hi' });
    expect(dropped).toEqual([]);
  });

  it('returns the retired threadTs once the agent passes the cap', () => {
    let last = [];
    for (let i = 0; i < 101; i++) {
      last = conversations.recordConversation(AGENT, `17800000${String(i).padStart(3, '0')}.000001`,
        { channel: 'D1', userId: 'U1', text: `m${i}` });
    }
    expect(last.length).toBe(1);
    // The OLDEST is the one retired, and it is genuinely gone from the in-memory model.
    expect(last[0]).toBe('17800000000.000001');
    const all = conversations.getConversations(AGENT, { limit: 200 }).items.map((c) => c.threadTs);
    expect(all).not.toContain('17800000000.000001');
    expect(all.length).toBe(100);
  });

  it('never retires a pinned conversation', () => {
    const oldest = '17800000000.000001';
    conversations.recordConversation(AGENT, oldest, { channel: 'D1', userId: 'U1', text: 'keep me' });
    conversations.togglePin(AGENT, oldest);
    let dropped = [];
    for (let i = 1; i < 101; i++) {
      dropped = conversations.recordConversation(AGENT, `17800000${String(i).padStart(3, '0')}.000001`,
        { channel: 'D1', userId: 'U1', text: `m${i}` });
    }
    expect(dropped).not.toContain(oldest);
    const all = conversations.getConversations(AGENT, { limit: 200 }).items.map((c) => c.threadTs);
    expect(all).toContain(oldest);
  });
});
