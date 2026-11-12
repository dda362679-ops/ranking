const cfg = require('./config');

class RobloxError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = { ok: null, at: 0, message: 'No requests yet' };

async function req(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(10000) });
    } catch {
      if (i === tries - 1) { Object.assign(state, { ok: false, at: Date.now(), message: 'Network error' }); throw new RobloxError('network', 'network'); }
      await sleep(500 * 2 ** i); continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (i === tries - 1) {
        Object.assign(state, { ok: false, at: Date.now(), message: `HTTP ${res.status}` });
        throw new RobloxError(res.status === 429 ? 'rate_limit' : 'http', res.status === 429 ? 'rate_limit' : `Roblox returned ${res.status}`);
      }
      await sleep(Math.max((Number(res.headers.get('retry-after')) || 0) * 1000, 1000 * 2 ** i)); continue;
    }
    Object.assign(state, { ok: true, at: Date.now(), message: 'OK' });
    return res;
  }
}

module.exports = {
  RobloxError, state,

  async resolveUsername(name) {
    const res = await req('https://users.roblox.com/v1/usernames/users', { method: 'POST', body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }) });
    if (!res.ok) throw new RobloxError('http', `Roblox username lookup returned ${res.status}`);
    const u = ((await res.json()).data || [])[0];
    return u ? { id: String(u.id), name: u.name } : null;
  },

  async getUser(id) {
    const res = await req(`https://users.roblox.com/v1/users/${id}`);
    if (!res.ok) throw new RobloxError('http', `Roblox profile lookup returned ${res.status}`);
    return res.json();
  },

  async getAvatar(userId) {
    const res = await req(`https://avatar.roblox.com/v1/users/${userId}/avatar`);
    if (!res.ok) throw new RobloxError('http', `Roblox avatar lookup returned ${res.status}`);
    return res.json();
  },

  async getHeadshot(userId) {
    const res = await req(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=150x150&format=Png&isCircular=true`);
    if (!res.ok) throw new RobloxError('http', `Roblox avatar thumbnail lookup returned ${res.status}`);
    const data = (await res.json()).data || [];
    return data[0]?.imageUrl || null;
  },

  // true/false only on a clean answer. Anything else THROWS so a failure is never read as "owns nothing".
  async ownsAsset(userId, assetId) {
    const res = await req(`https://inventory.roblox.com/v1/users/${userId}/items/Asset/${assetId}/is-owned`);
    if (res.status === 403) throw new RobloxError('private', 'private');
    if (!res.ok) throw new RobloxError('http', `Roblox inventory API returned ${res.status}`);
    const j = await res.json();
    if (typeof j !== 'boolean') throw new RobloxError('http', 'Unexpected response from the Roblox inventory API.');
    return j;
  },

  async getGroupRole(userId) {
    const res = await req(`https://groups.roblox.com/v2/users/${userId}/groups/roles?includeLocked=true`);
    if (!res.ok) throw new RobloxError('http', `Roblox group lookup returned ${res.status}`);
    const row = ((await res.json()).data || []).find(d => String(d.group.id) === cfg.GROUP_ID);
    return row ? row.role : null; // {id,name,rank}
  },

  async getGroupRoles() {
    const res = await req(`https://groups.roblox.com/v1/groups/${cfg.GROUP_ID}/roles`);
    if (!res.ok) throw new RobloxError('http', `Roblox group roles lookup returned ${res.status}`);
    return (await res.json()).roles || [];
  },

  async getGroupInfo() {
    const res = await req(`https://groups.roblox.com/v1/groups/${cfg.GROUP_ID}`);
    if (!res.ok) throw new RobloxError('http', `Roblox group lookup returned ${res.status}`);
    return res.json();
  },

  // Open Cloud group-membership update. Success is only reported after re-reading the role from Roblox.
  async setGroupRole(userId, roleId) {
    if (!cfg.OPEN_CLOUD_KEY) throw new RobloxError('config', 'ROBLOX_OPEN_CLOUD_KEY is not configured, so Roblox ranks cannot be changed.');
    const res = await req(`https://apis.roblox.com/cloud/v2/groups/${cfg.GROUP_ID}/memberships/${userId}`, {
      method: 'PATCH', headers: { 'x-api-key': cfg.OPEN_CLOUD_KEY },
      body: JSON.stringify({ role: `groups/${cfg.GROUP_ID}/roles/${roleId}` }),
    });
    if (!res.ok) throw new RobloxError('permission', `Roblox refused the rank change (HTTP ${res.status}). Check the API key's group permissions and that the key owner outranks the target role.`);
    const now = await module.exports.getGroupRole(userId);
    if (!now || String(now.id) !== String(roleId)) throw new RobloxError('unconfirmed', 'Roblox did not confirm the rank change, so the rank is treated as unchanged.');
    return now;
  },

  async ping() {
    try { const r = await req('https://users.roblox.com/v1/users/1', {}, 1); return r.ok; } catch { return false; }
  },
};
