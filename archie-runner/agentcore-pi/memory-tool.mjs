// memory_search / memory_get tools — recreate CURRENT OpenClaw behaviour (keyword/FTS
// over MEMORY.md + memory/*.md), which is what production actually runs (semantic
// embeddings were never wired — see pi-config-coverage-audit). Direct off the EFS
// workspace. Titan/semantic embeddings are a later enhancement (user 2026-07-21).

import fs from 'node:fs';
import path from 'node:path';
import { piAi } from './pi-runtime.mjs';

const T = piAi.Type;

function memoryFiles(cwd) {
  const files = [];
  for (const n of ['MEMORY.md', 'memory.md']) if (fs.existsSync(path.join(cwd, n))) files.push(n);
  try {
    for (const f of fs.readdirSync(path.join(cwd, 'memory'))) if (f.endsWith('.md')) files.push(path.join('memory', f));
  } catch { /* no memory/ dir */ }
  return files;
}

export function createMemoryTools(cwd) {
  const memory_search = {
    name: 'memory_search',
    label: 'memory_search',
    capability: 'memory',
    description: 'Mandatory recall step: search MEMORY.md + memory/*.md for prior work, decisions, dates, people, preferences, or todos before answering. Returns top snippets with path + lines.',
    parameters: T.Object({ query: T.String(), maxResults: T.Optional(T.Number()) }),
    async execute(_toolCallId, params) {
      const terms = String(params?.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const max = params?.maxResults || 5;
      const hits = [];
      for (const rel of memoryFiles(cwd)) {
        let text;
        try { text = fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 3) { // stride 3 over ~6-line windows
          const window = lines.slice(i, i + 6).join('\n');
          const wl = window.toLowerCase();
          const score = terms.reduce((s, t) => s + (wl.includes(t) ? 1 : 0), 0);
          if (score > 0) hits.push({ path: rel, startLine: i + 1, endLine: Math.min(i + 6, lines.length), score, snippet: window.trim().slice(0, 400) });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const results = hits.slice(0, max);
      const payload = { results, provider: 'builtin-fts', model: 'keyword', hits: results.length };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload };
    },
  };

  const memory_get = {
    name: 'memory_get',
    label: 'memory_get',
    capability: 'memory',
    description: 'Read a snippet from MEMORY.md or memory/*.md (optional from/lines). Use after memory_search to pull only the needed lines.',
    parameters: T.Object({ path: T.String(), from: T.Optional(T.Number()), lines: T.Optional(T.Number()) }),
    async execute(_toolCallId, params) {
      const rel = String(params?.path || '');
      const abs = path.resolve(cwd, rel);
      if (abs !== cwd && !abs.startsWith(cwd + path.sep)) {
        return { content: [{ type: 'text', text: JSON.stringify({ text: '', path: rel, error: 'path outside workspace' }) }], details: { error: 'path' } };
      }
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { return { content: [{ type: 'text', text: JSON.stringify({ text: '', path: rel, error: 'not found' }) }], details: { error: 'enoent' } }; }
      const all = text.split('\n');
      const from = Math.max(1, params?.from || 1);
      const slice = all.slice(from - 1, from - 1 + (params?.lines || all.length)).join('\n');
      const payload = { text: slice, path: rel, startLine: from, endLine: from + slice.split('\n').length - 1 };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: payload };
    },
  };

  return { memory_search, memory_get };
}

export function buildMemoryTools(allow, cwd) {
  const { memory_search, memory_get } = createMemoryTools(cwd);
  const t = [];
  if (allow.has('memory_search')) t.push(memory_search);
  if (allow.has('memory_get')) t.push(memory_get);
  return t;
}
