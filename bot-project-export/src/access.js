const { PermissionFlagsBits } = require('discord.js');
const db = require('./db');
const roblox = require('./roblox');
const { E, friendly } = require('./util');

const locks = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Checks EVERY configured shirt. Throws if any single check fails (never treated as "not owned").
async function checkOwnership(robloxId) {
  const owned = [];
  for (const t of db.getTiers()) if (await roblox.ownsAsset(robloxId, t.shirt_id)) owned.push(t);
  return { owned, highest: owned.length ? owned[owned.length - 1] : null }; // tiers sorted by priority asc
}

function pickTarget(shirt, manual) {
  if (shirt && manual) return manual.priority > shirt.priority ? { tier: manual, staff: true } : { tier: shirt, staff: false };
  if (manual) return { tier: manual, staff: true };
  return { tier: shirt || null, staff: false };
}

async function syncDiscordRoles(guild, id, target, staffId) {
  const out = { added: [], removed: [], errors: [] };
  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) { out.errors.push('Bot is missing the Manage Roles permission.'); return out; }
  let member;
  try { member = await guild.members.fetch(id); } catch { out.errors.push('Member is not in this Discord server.'); return out; }
  const link = db.getLink(id);
  const mine = me.roles.highest.position;
  const usable = t => {
    const r = guild.roles.cache.get(t.discord_role_id);
    if (!r) { out.errors.push(`${t.name}: Discord role ${t.discord_role_id} was not found.`); return null; }
    if (r.managed || r.position >= mine) { out.errors.push(`${t.name}: move the bot's role above @${r.name} in Server Settings → Roles.`); return null; }
    return r;
  };
  let targetOk = true;
  if (target && !member.roles.cache.has(target.discord_role_id)) {
    const r = usable(target); targetOk = false;
    if (r) {
      try {
        await member.roles.add(r, 'WNM access sync'); targetOk = true; out.added.push(target.name);
        db.addAudit({ discord_id: id, roblox_id: link?.roblox_id, action: 'role_add', next: target.name, staff_id: staffId });
      } catch (e) { out.errors.push(`${target.name}: could not assign role (${e.message}).`); }
    }
  }
  if (!targetOk) return out; // never strip lower roles if the new one could not be given
  for (const t of db.getTiers()) {
    if (target && t.key === target.key) continue;
    if (!member.roles.cache.has(t.discord_role_id)) continue;
    const r = usable(t); if (!r) continue;
    try {
      await member.roles.remove(r, 'WNM access sync'); out.removed.push(t.name);
      db.addAudit({ discord_id: id, roblox_id: link?.roblox_id, action: 'role_remove', prev: t.name, staff_id: staffId });
    } catch (e) { out.errors.push(`${t.name}: could not remove role (${e.message}).`); }
  }
  return out;
}

async function syncGroup(link, target, staffId) {
  try {
    const cur = await roblox.getGroupRole(link.roblox_id);
    if (!cur) return { status: 'not_member', message: 'Linked account is not in the WNM Roblox group.' };
    if (String(cur.id) === String(target.group_role_id)) return { status: 'ok', message: `Already **${cur.name}**.` };
    // Safety: never touch a role ranked above the highest configured access role (staff / owner ranks).
    const roles = await roblox.getGroupRoles();
    const ranks = db.getTiers().map(t => roles.find(r => String(r.id) === String(t.group_role_id))?.rank).filter(x => x != null);
    if (!roles.find(r => String(r.id) === String(target.group_role_id))) return { status: 'error', message: `Group role ${target.group_role_id} does not exist in group ${require('./config').GROUP_ID}.` };
    if (ranks.length && cur.rank > Math.max(...ranks)) return { status: 'protected', message: `Current group role **${cur.name}** is above the access ranks — left unchanged.` };
    await roblox.setGroupRole(link.roblox_id, target.group_role_id);
    db.addAudit({ discord_id: link.discord_id, roblox_id: link.roblox_id, action: 'group_rank_change', prev: `${cur.name} (${cur.id})`, next: target.group_role_id, staff_id: staffId });
    return { status: 'changed', message: `Rank changed **${cur.name}** → **${target.name}** (confirmed by Roblox).` };
  } catch (e) {
    return { status: 'error', message: friendly(e) + ' Current group rank preserved.' };
  }
}

async function _sync(guild, id, { staffId }) {
  const link = db.getLink(id);
  if (!link) return { ok: false, error: 'No linked Roblox account. Use `/verify` first.' };
  const manual = link.manual_tier ? db.getTier(link.manual_tier) : null;
  let own;
  let inventoryError = null;
  try { own = await checkOwnership(link.roblox_id); } catch (e) {
    db.addAudit({ discord_id: id, roblox_id: link.roblox_id, action: 'inventory_check_failed', next: friendly(e), staff_id: staffId });
    if (!manual) return { ok: false, apiFailure: true, kind: e.kind, error: `${friendly(e)} **No roles or ranks were changed.**` };
    inventoryError = e;
    own = { owned: [], highest: null };
  }
  if (!inventoryError) {
    db.addAudit({ discord_id: id, roblox_id: link.roblox_id, action: 'inventory_check', next: own.owned.map(t => t.key).join(',') || 'none', staff_id: staffId });
  }

  const { tier, staff } = pickTarget(own.highest, manual);
  const res = {
    ok: true, tier, viaStaff: staff, owned: own.owned, discord: null, group: null,
    warnings: inventoryError ? [`Inventory could not be checked; using the staff-approved tier: ${friendly(inventoryError)}`] : [],
  };

  if (!tier && (db.getSetting('no_shirt_policy') || 'keep') === 'keep') {
    db.updateLink(id, { last_checked: Date.now() });
    return res;
  }
  res.discord = await syncDiscordRoles(guild, id, tier, staffId);
  res.group = tier ? await syncGroup(link, tier, staffId) : { status: 'skipped', message: 'No tier — Roblox group rank left unchanged.' };

  const newKey = tier ? tier.key : null;
  if ((link.current_tier || null) !== newKey) {
    db.addHistory({ discord_id: id, roblox_id: link.roblox_id, from_tier: link.current_tier, to_tier: newKey, source: staff ? 'staff-approved' : 'shirt-verified' });
    db.addAudit({ discord_id: id, roblox_id: link.roblox_id, action: 'tier_change', prev: link.current_tier, next: newKey, staff_id: staffId });
  }
  db.updateLink(id, { current_tier: newKey, last_checked: Date.now() });
  return res;
}

async function syncMember(guild, id, opts = {}) {
  if (locks.has(id)) return { ok: false, error: 'A rank operation for this member is already running. Try again in a moment.' };
  locks.add(id);
  try { return await _sync(guild, id, opts); } finally { locks.delete(id); }
}

let fullSyncRunning = false;
async function syncAll(guild, staffId) {
  if (fullSyncRunning) return { ok: false, error: 'A full sync is already running.' };
  fullSyncRunning = true;
  const s = { ok: true, total: 0, done: 0, failed: 0 };
  try {
    for (const l of db.allLinks()) {
      s.total++;
      const r = await syncMember(guild, l.discord_id, { staffId });
      r.ok ? s.done++ : s.failed++;
      await sleep(1500); // stay under Roblox rate limits
    }
  } finally { fullSyncRunning = false; }
  db.addAudit({ action: 'sync_all', next: `${s.done}/${s.total} ok, ${s.failed} failed`, staff_id: staffId });
  return s;
}

async function unlinkMember(guild, id, staffId) {
  const link = db.getLink(id);
  if (!link) return false;
  await syncDiscordRoles(guild, id, null, staffId); // removes managed access roles only
  db.deleteLink(id);
  db.addHistory({ discord_id: id, roblox_id: link.roblox_id, from_tier: link.current_tier, to_tier: null, source: 'unlinked' });
  db.addAudit({ discord_id: id, roblox_id: link.roblox_id, action: 'account_unlink', prev: `${link.roblox_name} (${link.roblox_id})`, staff_id: staffId });
  return true;
}

async function dm(client, id, embed) {
  try { await (await client.users.fetch(id)).send({ embeds: [embed] }); } catch { /* DMs closed */ }
}

function requestReview(discordId, tierKey, reason) {
  const link = db.getLink(discordId);
  if (!link) return { ok: false, error: 'Link a Roblox account first with `/verify`.' };
  const tier = db.getTier(tierKey);
  if (!tier) return { ok: false, error: `Unknown tier \`${tierKey}\`.` };
  if (db.pendingReviewFor(discordId)) return { ok: false, error: 'You already have a pending review.' };
  const id = db.createReview({ discord_id: discordId, roblox_id: link.roblox_id, roblox_name: link.roblox_name, requested_tier: tier.key, reason });
  db.addAudit({ discord_id: discordId, roblox_id: link.roblox_id, action: 'review_requested', next: `#${id} ${tier.key}: ${reason}` });
  return { ok: true, id, tier };
}

async function approveReview(guild, id, staffId, note) {
  const rv = db.getReview(Number(id));
  if (!rv || rv.status !== 'pending') return { ok: false, error: 'No pending review with that ID.' };
  const link = db.getLink(rv.discord_id);
  const tier = db.getTier(rv.requested_tier);
  if (!link || !tier) return { ok: false, error: 'This review is no longer eligible (account unlinked or tier removed).' };
  db.updateLink(rv.discord_id, { manual_tier: tier.key });
  db.finishReview(rv.id, 'approved', staffId, note || '');
  db.addAudit({ discord_id: rv.discord_id, roblox_id: rv.roblox_id, action: 'staff_approval', prev: link.manual_tier, next: `${tier.key} — ${note || 'no note'}`, staff_id: staffId });
  const r = await syncMember(guild, rv.discord_id, { staffId });
  await dm(guild.client, rv.discord_id, E('Access review approved', `Staff approved your request for **${tier.name}**.\nThis is **staff-approved access**, not automatic inventory verification.${note ? `\nNote: ${note}` : ''}`));
  return { ok: true, review: rv, tier, sync: r };
}

async function denyReview(guild, id, staffId, reason) {
  const rv = db.getReview(Number(id));
  if (!rv || rv.status !== 'pending') return { ok: false, error: 'No pending review with that ID.' };
  if (!reason) return { ok: false, error: 'A denial reason is required.' };
  db.finishReview(rv.id, 'denied', staffId, reason);
  db.addAudit({ discord_id: rv.discord_id, roblox_id: rv.roblox_id, action: 'staff_denial', next: reason, staff_id: staffId });
  await dm(guild.client, rv.discord_id, E('Access review denied', `Your request for **${rv.requested_tier}** was denied.\nReason: ${reason}`));
  return { ok: true, review: rv };
}

module.exports = { checkOwnership, syncMember, syncAll, syncDiscordRoles, unlinkMember, requestReview, approveReview, denyReview, pickTarget };
