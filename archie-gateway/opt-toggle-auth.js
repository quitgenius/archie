'use strict';
function canToggleAgent({ userId, targetAgent, dmUsers = {}, ownedAgents = {} }) {
  if (!userId || !targetAgent) return false;
  if (dmUsers[userId] === targetAgent) return true;
  return Array.isArray(ownedAgents[userId]) && ownedAgents[userId].includes(targetAgent);
}
module.exports = { canToggleAgent };
