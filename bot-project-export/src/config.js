const path = require('path');
require('dotenv').config();
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);

module.exports = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  GUILD_ID: process.env.GUILD_ID,
  PREFIX: process.env.PREFIX || '.',
  STAFF_ROLE_IDS: list(process.env.STAFF_ROLE_IDS),
  ADMIN_ROLE_IDS: list(process.env.ADMIN_ROLE_IDS),
  OWNER_IDS: list(process.env.OWNER_IDS),

  // Official WNM Roblox group. Hard-coded on purpose.
  GROUP_ID: '921240375',
  GROUP_URL: 'https://www.roblox.com/share/g/921240375',
  OPEN_CLOUD_KEY: process.env.ROBLOX_OPEN_CLOUD_KEY || '',

  DASHBOARD_URL: (process.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, ''),
  PORT: Number(process.env.PORT) || 3000,
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  OWNER_PIN: process.env.OWNER_PIN || '',
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Seeded into the database on first run only. After that, edit via commands/dashboard.
  DEFAULT_TIERS: [
    { key: 'bronze', name: 'Bronze Access', priority: 1, shirt_id: '107156710471318', group_role_id: '911828094', discord_role_id: '1566664637867368458' },
    { key: 'silver', name: 'Silver Access', priority: 2, shirt_id: '122863750425004', group_role_id: '913460007', discord_role_id: '1566664719903891620' },
    { key: 'gold',   name: 'Gold Access',   priority: 3, shirt_id: '109721038082320', group_role_id: '912402133', discord_role_id: '1566664786937118801' },
    { key: 'vip',    name: 'VIP Access',    priority: 4, shirt_id: '72719142393748',  group_role_id: '913258129', discord_role_id: '1566664887860592670' },
    { key: 'elite',  name: 'Elite Access',  priority: 5, shirt_id: '86204703449089',  group_role_id: '912450122', discord_role_id: '1566664960036307114' },
  ],
};
