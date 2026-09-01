'use strict';

// Build owner lookup maps from per-agent slack.json `owners` arrays.
// Slack ids are canonically uppercase; normalize so a lowercased config
// entry still matches the (uppercased) clicker id at toggle time.
function buildOwnerMaps(agentSlackConfigs) {
  const agentOwners = {};
  const ownedAgents = {};
  for (const { agentName, owners } of agentSlackConfigs) {
    if (!Array.isArray(owners) || owners.length === 0) continue;
    const norm = [...new Set(owners.filter((o) => typeof o === 'string' && o).map((o) => o.toUpperCase()))];
    if (norm.length === 0) continue;
    agentOwners[agentName] = norm;
    for (const owner of norm) {
      (ownedAgents[owner] ||= []).push(agentName);
    }
  }
  for (const owner of Object.keys(ownedAgents)) ownedAgents[owner].sort();
  return { agentOwners, ownedAgents };
}

module.exports = { buildOwnerMaps };
