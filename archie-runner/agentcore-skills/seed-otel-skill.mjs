// Seed the otel-debug skill into the agent-config DynamoDB table: write its SKILL#<name>/DEF item,
// merge it into SKILL#_manifest, and (optionally) install it onto one or more agents' MARKETPLACE.
//
// The skill's real home is the fleet skill source that extract.mjs packs (sandra `../skills`); this
// script is the bridge for the sandbox / until that lands, and matches extract.mjs's item shape
// byte-for-byte (files map + version = hash16(JSON.stringify(files))) so a later re-pack is a no-op.
//
//   AWS_PROFILE=sandbox AGENT_CONFIG_TABLE=agent-4ggvzl-config \
//     node seed-otel-skill.mjs [--src <dir>] [--install <agent>[,<agent>...]] [--dry-run]
//
// Idempotent: DEF/manifest are read-modify-write (manifest preserves other skills + catalogVersion);
// an install adds the key only if absent. Reuses config-resolver's schema + DDB client so the key
// shape lives in exactly one place.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const schema = await import(path.join(HERE, '..', 'config-resolver', 'schema.mjs'));
const ddb = await import(path.join(HERE, '..', 'config-resolver', 'ddb-local.mjs'));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes('--dry-run');
const SKILL_NAME = 'otel-debug';
const srcDir = arg('--src', path.join(HERE, SKILL_NAME));
const installAgents = (arg('--install', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const hash16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Collect the skill's files keyed by POSIX-relative path (mirrors extract.mjs walk()).
function collectFiles(dir, base = dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, collectFiles(abs, base));
    else out[path.relative(base, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
  }
  return out;
}

async function main() {
  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) throw new Error(`no SKILL.md under ${srcDir}`);
  const files = collectFiles(srcDir);
  const version = hash16(JSON.stringify(files));
  const table = process.env.AGENT_CONFIG_TABLE || schema.TABLE;
  console.log(`skill=${SKILL_NAME} version=${version} files=${Object.keys(files).join(', ')} table=${table}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`install→ ${installAgents.length ? installAgents.join(', ') : '(none)'}`);
  if (dryRun) return;

  const { doc } = ddb.makeClients();
  const { GetCommand, PutCommand } = ddb._require('@aws-sdk/lib-dynamodb');
  const get = async (Key) => (await doc.send(new GetCommand({ TableName: table, Key }))).Item;
  const put = async (Item) => doc.send(new PutCommand({ TableName: table, Item }));

  // 1. DEF
  await put(schema.item(schema.skillKey(SKILL_NAME), { files, version }));
  console.log(`✓ wrote SKILL#${SKILL_NAME}/DEF`);

  // 2. manifest (read-modify-write; never clobber other skills)
  const manifest = schema.readData(await get(schema.skillManifestKey())) || { skills: {}, catalogVersion: null };
  manifest.skills = { ...manifest.skills, [SKILL_NAME]: version };
  await put(schema.item(schema.skillManifestKey(), manifest));
  console.log(`✓ merged into SKILL#_manifest (${Object.keys(manifest.skills).length} skills)`);

  // 3. optional per-agent installs
  for (const agent of installAgents) {
    const mkt = schema.readData(await get(schema.marketplaceKey(agent))) || { installs: {}, connectors: {}, models: {} };
    mkt.installs = mkt.installs || {};
    if (mkt.installs[SKILL_NAME]) { console.log(`= ${agent} already has ${SKILL_NAME}`); continue; }
    mkt.installs[SKILL_NAME] = { installedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), installedBy: 'otel-debug-seed' };
    await put(schema.item(schema.marketplaceKey(agent), mkt));
    console.log(`✓ installed ${SKILL_NAME} onto ${agent}`);
  }
}

main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });
