const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const cfg = require('./config');

const RED = 0xC8102E;
const E = (title, desc) => {
  const e = new EmbedBuilder().setColor(RED).setFooter({ text: 'WNM • Official Access System' }).setTimestamp();
  if (title) e.setTitle(title);
  if (desc) e.setDescription(desc);
  return e;
};
const ts = ms => (ms ? `<t:${Math.floor(ms / 1000)}:f>` : '—');

// 0 = member, 1 = staff, 2 = admin, 3 = owner
function level(member) {
  if (!member) return 0;
  if (cfg.OWNER_IDS.includes(member.id)) return 3;
  if (member.permissions?.has(PermissionFlagsBits.Administrator) || cfg.ADMIN_ROLE_IDS.some(r => member.roles.cache.has(r))) return 2;
  if (cfg.STAFF_ROLE_IDS.some(r => member.roles.cache.has(r))) return 1;
  return 0;
}

function friendly(e) {
  const map = {
    private: 'The Roblox inventory is private or hidden, so shirt ownership could not be checked.',
    rate_limit: 'Roblox is rate-limiting requests right now. Please try again in a minute.',
    network: 'Could not reach Roblox. Please try again shortly.',
  };
  if (e && map[e.kind]) return map[e.kind];
  return e && e.message ? e.message : 'Unexpected error.';
}

module.exports = { E, RED, ts, level, friendly };
