const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const roblox = require('./roblox');
const access = require('./access');
const { E, ts, level, friendly } = require('./util');

const cmds = {};
const def = (names, lvl, run) => { for (const n of [].concat(names)) cmds[n] = { level: lvl, run }; };
const tName = k => (db.getTier(k) ? db.getTier(k).name : k || 'None');
const denied = ctx => ctx.reply({ embeds: [E('Permission denied', 'You do not have permission to do that.')] });
const cooldowns = new Map();

async function resolveTarget(arg) {
  if (!arg) return null;
  const m = arg.match(/^<@!?(\d+)>$/) || arg.match(/^(\d{15,20})$/);
  if (m) return m[1];
  const l = db.getLinkByName(arg);
  return l ? l.discord_id : null;
}
const noLink = ctx => ctx.reply({ embeds: [E('Not verified', 'No linked Roblox account. Use `/verify` (or `.verify <username>`).')] });
const displayText = value => String(value || '').replace(/[\r\n]/g, ' ').replace(/([*_`~|])/g, '\\$1').slice(0, 120);

function clothingLabel(asset) {
  const type = asset.assetType || {};
  const id = String(type.id || asset.assetTypeId || '');
  if (id === '12') return 'Pants';
  if (id === '2') return 'T-Shirt';
  if (id === '11') return 'Shirt';
  const name = String(type.name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (name === 'pants') return 'Pants';
  if (name === 'tshirt') return 'T-Shirt';
  if (name === 'shirt') return 'Shirt';
  return null;
}

function clothingSummary(avatar) {
  const assets = Array.isArray(avatar?.assets) ? avatar.assets : [];
  return ['Pants', 'T-Shirt', 'Shirt'].map(label => {
    const matches = assets.filter(asset => clothingLabel(asset) === label);
    const names = matches.slice(0, 3).map(asset => {
      const name = displayText(asset.name || 'Unnamed item');
      return asset.id ? `${name} (${asset.id})` : name;
    });
    if (matches.length > names.length) names.push(`+${matches.length - names.length} more`);
    return `**${label}:** ${names.join(', ') || 'None'}`;
  }).join('\n');
}

function safeField(value) {
  const text = String(value || 'None');
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

/* ---------------- verification ---------------- */
async function startVerify(ctx, username) {
  if (!username) return ctx.reply({ embeds: [E('Verify', 'Usage: `/verify <roblox username>`')] });
  if (db.getLink(ctx.user.id)) return ctx.reply({ embeds: [E('Already linked', 'You already have a linked account. Use `.unlink` first to change it.')] });
  let r;
  try { r = await roblox.resolveUsername(username); } catch (e) { return ctx.reply({ embeds: [E('Roblox unavailable', friendly(e))] }); }
  if (!r) return ctx.reply({ embeds: [E('User not found', `No Roblox user named \`${username}\`.`)] });
  const other = db.getLinkByRoblox(r.id);
  if (other) {
    db.addAudit({ discord_id: ctx.user.id, roblox_id: r.id, action: 'verify_failed', next: 'roblox account already linked to another member' });
    return ctx.reply({ embeds: [E('Account already linked', 'That Roblox account is already linked to another Discord member.')] });
  }
  const code = 'WNM-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  db.savePending({ discord_id: ctx.user.id, roblox_id: r.id, roblox_name: r.name, code, expires: Date.now() + 15 * 60e3 });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_confirm').setLabel('I added the code — verify').setStyle(ButtonStyle.Danger));
  return ctx.reply({
    embeds: [E('Prove you own this account', `Roblox account: **${r.name}** (${r.id})\n\n1. Open your Roblox profile → edit **About / Description**.\n2. Paste this code anywhere in it:\n\`\`\`${code}\`\`\`\n3. Save, then press the button below. The code expires <t:${Math.floor((Date.now() + 15 * 60e3) / 1000)}:R>.`)],
    components: [row], ephemeral: true,
  });
}

async function confirmVerify(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.user.id;
  const p = db.getPending(id);
  if (!p || p.expires < Date.now()) { db.delPending(id); return interaction.editReply({ embeds: [E('Expired', 'No active verification. Run `/verify` again.')] }); }
  let prof;
  try { prof = await roblox.getUser(p.roblox_id); } catch (e) { return interaction.editReply({ embeds: [E('Roblox unavailable', friendly(e))] }); }
  if (!(prof.description || '').includes(p.code)) {
    db.addAudit({ discord_id: id, roblox_id: p.roblox_id, action: 'verify_failed', next: 'code not found on profile' });
    return interaction.editReply({ embeds: [E('Code not found', 'The code is not in that profile description yet. Save your profile, wait a few seconds, and press the button again.')] });
  }
  try { db.insertLink({ discord_id: id, roblox_id: p.roblox_id, roblox_name: prof.name }); } catch {
    db.addAudit({ discord_id: id, roblox_id: p.roblox_id, action: 'verify_failed', next: 'duplicate link blocked' });
    return interaction.editReply({ embeds: [E('Could not link', 'That Roblox account or your Discord account is already linked.')] });
  }
  db.delPending(id);
  db.addAudit({ discord_id: id, roblox_id: p.roblox_id, action: 'verify_success', next: `${prof.name} (${p.roblox_id})` });
  db.addAudit({ discord_id: id, roblox_id: p.roblox_id, action: 'account_link', next: prof.name });
  const r = await access.syncMember(interaction.guild, id, {});
  return interaction.editReply({ embeds: [E('Verified ✅', `Linked **${prof.name}**. You can remove the code from your profile now.`), syncEmbed(r, db.getLink(id))] });
}

async function confirmUnlink(interaction) {
  if (interaction.user.id !== interaction.customId.split(':')[1]) return interaction.reply({ content: 'This confirmation is not yours.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const ok = await access.unlinkMember(interaction.guild, interaction.user.id, null);
  return interaction.editReply({ embeds: [E(ok ? 'Account unlinked' : 'Nothing to unlink', ok ? 'Your Roblox account was unlinked and WNM access roles were removed.' : 'No linked account found.')] });
}

/* ---------------- rendering ---------------- */
function syncEmbed(r, link) {
  if (!r.ok) return E(r.apiFailure ? 'Inventory check unavailable' : 'Rank check failed', r.error);
  const e = E('Access check complete', r.tier ? `Highest access: **${r.tier.name}**${r.viaStaff ? ' *(staff-approved)*' : ''}` : 'This member does not currently qualify for an access tier.');
  e.addFields(
    { name: 'Roblox account', value: `${link.roblox_name} (${link.roblox_id})`, inline: true },
    { name: 'Shirts owned', value: r.owned.map(t => t.name).join(', ') || 'None', inline: true });
  if (r.discord) {
    const d = r.discord, parts = [];
    if (d.added.length) parts.push(`Added: ${d.added.join(', ')}`);
    if (d.removed.length) parts.push(`Removed: ${d.removed.join(', ')}`);
    if (!parts.length && !d.errors.length) parts.push('Already correct.');
    if (d.errors.length) parts.push('⚠️ ' + d.errors.join('\n⚠️ '));
    e.addFields({ name: 'Discord roles', value: parts.join('\n').slice(0, 1000) });
  }
  if (r.group) e.addFields({ name: 'Roblox group', value: r.group.message.slice(0, 1000) });
  if (r.warnings.length) e.addFields({ name: 'Notes', value: r.warnings.join('\n') });
  return e;
}

async function grantManualAccess(ctx) {
  const targetId = await resolveTarget(ctx.args[0]);
  const tierName = ctx.args[1];
  const tier = db.getTier(tierName);
  if (!targetId || !tierName) {
    return ctx.reply({ embeds: [E('Manual access grant', 'Usage: `.rank <@Discord user or ID> <tier> [reason]`')] });
  }
  if (!tier) {
    return ctx.reply({ embeds: [E('Unknown tier', `Choose one of: ${db.getTiers().map(t => t.key).join(', ')}.`)] });
  }

  let member;
  try { member = await ctx.guild.members.fetch(targetId); } catch {
    return ctx.reply({ embeds: [E('Discord user not found', 'That user must be a member of this server.')] });
  }
  if (member.user.bot) return ctx.reply({ embeds: [E('Invalid user', 'Bot accounts cannot receive access tiers.')] });

  const link = db.getLink(targetId);
  if (!link) {
    return ctx.reply({ embeds: [E('Roblox account required', 'The member must link a Roblox account first with `.verify` or staff can link it with `.mverify`. Shirt ownership is not required for this staff grant.')] });
  }

  const previous = link.manual_tier ? db.getTier(link.manual_tier) : null;
  const reason = ctx.args.slice(2).join(' ').trim().slice(0, 200);
  db.updateLink(targetId, { manual_tier: tier.key });
  db.addAudit({
    discord_id: targetId,
    roblox_id: link.roblox_id,
    action: 'staff_access_grant',
    prev: previous?.name || null,
    next: `${tier.name}${reason ? ` — ${reason}` : ''}`,
    staff_id: ctx.user.id,
  });

  let sync;
  try { sync = await access.syncMember(ctx.guild, targetId, { staffId: ctx.user.id }); } catch (e) {
    sync = { ok: false, error: `The manual grant was saved, but access sync failed: ${friendly(e)}` };
  }
  const confirmation = E(
    'Manual access grant recorded',
    `<@${targetId}> has a staff-approved **${tier.name}** override. Shirt ownership is not required.${previous ? `\nPrevious override: **${previous.name}**.` : ''}${reason ? `\nReason: ${reason}` : ''}`,
  );
  return ctx.reply({ embeds: [confirmation, syncEmbed(sync, db.getLink(targetId))] });
}

/* ---------------- member commands ---------------- */
def('verify', 0, ctx => startVerify(ctx, ctx.args[0]));

async function history(ctx, id) {
  const rows = db.history(id, 10);
  return ctx.reply({ embeds: [E('Ranking history', rows.length ? rows.map(h => `${ts(h.at)} — ${tName(h.from_tier)} → ${tName(h.to_tier)} *(${h.source})*`).join('\n') : 'No changes recorded.')] });
}

def('rank', 0, async ctx => {
  const a0 = (ctx.args[0] || '').toLowerCase();
  if (a0 === 'history') {
    if (ctx.args[1]) { if (level(ctx.member) < 1) return denied(ctx); const t = await resolveTarget(ctx.args[1]); return t ? history(ctx, t) : ctx.reply({ embeds: [E('Not found', 'Member not found.')] }); }
    return history(ctx, ctx.user.id);
  }
  if (ctx.args[1]) {
    if (level(ctx.member) < 1) return denied(ctx);
    return grantManualAccess(ctx);
  }
  let target = ctx.user.id;
  if (ctx.args[0]) {
    if (level(ctx.member) < 1) return denied(ctx);
    target = await resolveTarget(ctx.args[0]);
    if (!target) return ctx.reply({ embeds: [E('Not found', 'Member not found.')] });
  } else {
    const last = cooldowns.get(target) || 0;
    if (Date.now() - last < 30000) return ctx.reply({ embeds: [E('Slow down', 'Please wait 30 seconds between rank checks.')] });
    cooldowns.set(target, Date.now());
  }
  const link = db.getLink(target);
  if (!link) return noLink(ctx);
  const r = await access.syncMember(ctx.guild, target, { staffId: target === ctx.user.id ? null : ctx.user.id });
  const embed = syncEmbed(r, link);
  if (!r.ok && r.kind === 'private') embed.addFields({ name: 'Alternative', value: 'Set your inventory public and retry, or request staff review: `.requestreview <tier> <reason>`' });
  return ctx.reply({ embeds: [embed] });
});

def('myaccess', 0, async ctx => {
  const l = db.getLink(ctx.user.id); if (!l) return noLink(ctx);
  const e = E('Your access', `Current tier: **${tName(l.current_tier)}**`);
  if (l.manual_tier) e.addFields({ name: 'Staff-approved tier', value: tName(l.manual_tier) });
  e.addFields({ name: 'Last checked', value: ts(l.last_checked) });
  return ctx.reply({ embeds: [e] });
});

def('profile', 0, async ctx => {
  const l = db.getLink(ctx.user.id); if (!l) return noLink(ctx);
  return ctx.reply({ embeds: [E('Linked Roblox account').addFields(
    { name: 'Username', value: l.roblox_name, inline: true }, { name: 'User ID', value: l.roblox_id, inline: true },
    { name: 'Profile', value: `https://www.roblox.com/users/${l.roblox_id}/profile` },
    { name: 'Verified', value: ts(l.verified_at), inline: true }, { name: 'Tier', value: tName(l.current_tier), inline: true })] });
});

def('accesslist', 0, ctx => ctx.reply({ embeds: [E('WNM access tiers', db.getTiers().slice().reverse().map(t => `**${t.priority}. ${t.name}**${t.description ? ` — ${t.description}` : ''}`).join('\n') + '\n\nHighest owned tier always wins.')] }));

def('checkinventory', 0, async ctx => {
  const l = db.getLink(ctx.user.id); if (!l) return noLink(ctx);
  try {
    const o = await access.checkOwnership(l.roblox_id);
    const owned = new Set(o.owned.map(t => t.key));
    return ctx.reply({ embeds: [E('Shirt ownership (read-only)', db.getTiers().map(t => `${owned.has(t.key) ? '✅' : '❌'} ${t.name}`).join('\n') + `\n\nHighest: **${o.highest ? o.highest.name : 'none'}**\nThis check changes nothing — use \`.rank\` to sync.`)] });
  } catch (e) { return ctx.reply({ embeds: [E('Inventory check unavailable', friendly(e))] }); }
});

def('info', 0, async ctx => {
  const username = ctx.args[0];
  if (!username) return ctx.reply({ embeds: [E('Roblox info', 'Usage: `.info <Roblox username or user ID>`')] });
  const cooldownKey = `info:${ctx.user.id}`;
  const last = cooldowns.get(cooldownKey) || 0;
  if (Date.now() - last < 10000) return ctx.reply({ embeds: [E('Slow down', 'Please wait 10 seconds before requesting another Roblox profile.')] });
  cooldowns.set(cooldownKey, Date.now());

  let resolved;
  let profile;
  try {
    resolved = /^\d{1,20}$/.test(username)
      ? { id: username }
      : await roblox.resolveUsername(username);
    if (!resolved) return ctx.reply({ embeds: [E('User not found', `No Roblox user named \`${username}\`.`)] });
    profile = await roblox.getUser(resolved.id);
  } catch (e) {
    return ctx.reply({ embeds: [E('Roblox unavailable', friendly(e))] });
  }

  const [avatarResult, headshotResult, groupResult, ownershipResult] = await Promise.allSettled([
    roblox.getAvatar(resolved.id),
    roblox.getHeadshot(resolved.id),
    roblox.getGroupRole(resolved.id),
    access.checkOwnership(resolved.id),
  ]);
  const robloxName = profile.name || resolved.name || username;
  const title = `${displayText(profile.displayName || robloxName)} (@${displayText(robloxName)})`.slice(0, 256);
  const embed = E(title, `Roblox ID: **${resolved.id}**`)
    .setURL(`https://www.roblox.com/users/${encodeURIComponent(resolved.id)}/profile`);

  if (headshotResult.status === 'fulfilled' && headshotResult.value) embed.setThumbnail(headshotResult.value);

  const groupValue = groupResult.status === 'fulfilled'
    ? `${groupResult.value ? `${displayText(groupResult.value.name)} (rank ${groupResult.value.rank})` : 'Not a member'}\nGroup ID: ${cfg.GROUP_ID}`
    : `Could not load group membership: ${friendly(groupResult.reason)}`;
  embed.addFields({ name: 'Roblox group', value: safeField(groupValue), inline: true });

  const outfitValue = avatarResult.status === 'fulfilled'
    ? clothingSummary(avatarResult.value)
    : `Could not load avatar clothing: ${friendly(avatarResult.reason)}`;
  embed.addFields({ name: 'Currently wearing', value: safeField(outfitValue) });

  if (ownershipResult.status === 'fulfilled') {
    const tiers = db.getTiers();
    const ownedKeys = new Set(ownershipResult.value.owned.map(t => t.key));
    const owned = tiers.filter(t => ownedKeys.has(t.key));
    const notOwned = tiers.filter(t => !ownedKeys.has(t.key));
    embed.addFields(
      { name: 'Owned Access shirts', value: safeField(owned.map(t => `✅ ${displayText(t.name)}`).join('\n') || 'None') },
      { name: 'Not owned', value: safeField(notOwned.map(t => `❌ ${displayText(t.name)}`).join('\n') || 'None') },
    );
  } else {
    embed.addFields({ name: 'Access shirt ownership', value: safeField(`Could not check ownership: ${friendly(ownershipResult.reason)}`) });
  }

  return ctx.reply({ embeds: [embed] });
});

def('ganginfo', 0, async ctx => {
  try {
    const g = await roblox.getGroupInfo();
    return ctx.reply({ embeds: [E(g.name, (g.description || '').slice(0, 500)).addFields({ name: 'Members', value: String(g.memberCount), inline: true }, { name: 'Group ID', value: cfg.GROUP_ID, inline: true }, { name: 'Link', value: cfg.GROUP_URL })] });
  } catch (e) { return ctx.reply({ embeds: [E('Roblox unavailable', friendly(e))] }); }
});

def('leaderboard', 0, ctx => {
  const c = Object.fromEntries(db.countsByTier().map(r => [r.t || '_', r.c]));
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return ctx.reply({ embeds: [E('Access statistics', db.getTiers().slice().reverse().map(t => `**${t.name}:** ${c[t.key] || 0}`).join('\n') + `\n**No tier:** ${c._ || 0}\n\n**Total verified:** ${total}`)] });
});

def('requestreview', 0, ctx => {
  const [tier, ...rest] = ctx.args; const reason = rest.join(' ');
  if (!tier || !reason) return ctx.reply({ embeds: [E('Request review', 'Usage: `.requestreview <tier> <reason>`')] });
  const r = access.requestReview(ctx.user.id, tier, reason);
  return ctx.reply({ embeds: [E(r.ok ? 'Review requested' : 'Could not request review', r.ok ? `Review **#${r.id}** for **${r.tier.name}** is pending staff approval.` : r.error)] });
});

def('unlink', 0, ctx => {
  if (!db.getLink(ctx.user.id)) return noLink(ctx);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`unlink_confirm:${ctx.user.id}`).setLabel('Yes, unlink my account').setStyle(ButtonStyle.Danger));
  return ctx.reply({ embeds: [E('Unlink Roblox account?', 'This removes your link **and your WNM access roles**. You will need to verify again.')], components: [row] });
});

def('help', 0, ctx => {
  const lv = level(ctx.member), p = cfg.PREFIX;
  const e = E('WNM Access Bot — commands', [
    `\`/verify\` \`${p}verify <user>\` — link Roblox`, `\`${p}rank\` — check & sync access`, `\`${p}rank history\` — your changes`, `\`${p}myaccess\` \`${p}profile\``,
    `\`${p}info <Roblox username>\` — show profile, outfit, and access-shirt ownership`,
    `\`${p}accesslist\` \`${p}checkinventory\` \`${p}ganginfo\` \`${p}leaderboard\``, `\`${p}requestreview <tier> <reason>\``, `\`${p}unlink\``].join('\n'));
  if (lv >= 1) e.addFields({ name: 'Staff', value: [`${p}mverify <@user> <Roblox username>`, `${p}rank @user`, `${p}rank @user <tier> [reason]`, `${p}checkuser <user>`, `${p}pending`, `${p}approve <id> [note]`, `${p}deny <id> <reason>`, `${p}recheck <user>`, `${p}syncroles [user]`, `${p}audit [user]`].map(x => `\`${x}\``).join('\n') });
  if (lv >= 2) e.addFields({ name: 'Admin', value: [`${p}setshirt <tier> <id>`, `${p}setrole <tier> <@role>`, `${p}setrank <tier> <groupRoleId>`, `${p}editaccess <tier> <name|description|priority> <value>`, `${p}addaccess <key> <priority> <shirtId> <groupRoleId> <@role> <Name>`, `${p}removeaccess <tier>`].map(x => `\`${x}\``).join('\n') });
  if (lv >= 3) e.addFields({ name: 'Owner', value: `\`${p}setpolicy <keep|remove>\`` });
  return ctx.reply({ embeds: [e] });
});

/* ---------------- staff commands (level checked by dispatcher) ---------------- */
def('mverify', 1, async ctx => {
  const targetMatch = (ctx.args[0] || '').match(/^<@!?(\d+)>$/) || (ctx.args[0] || '').match(/^(\d{15,20})$/);
  const robloxUsername = ctx.args[1];
  if (!targetMatch || !robloxUsername) {
    return ctx.reply({ embeds: [E('Manual verification', 'Usage: `.mverify <@Discord user or ID> <Roblox username>`')] });
  }

  const discordId = targetMatch[1];
  let member;
  try { member = await ctx.guild.members.fetch(discordId); } catch {
    return ctx.reply({ embeds: [E('Discord user not found', 'That user must be a member of this server.')] });
  }
  if (member.user.bot) return ctx.reply({ embeds: [E('Invalid user', 'Bot accounts cannot be linked to Roblox accounts.')] });

  const currentLink = db.getLink(discordId);
  if (currentLink) {
    return ctx.reply({ embeds: [E('Already linked', `<@${discordId}> is already linked to **${currentLink.roblox_name}**. They must use \`.unlink\` before staff can link a different account.`)] });
  }

  let robloxUser;
  try { robloxUser = await roblox.resolveUsername(robloxUsername); } catch (e) {
    return ctx.reply({ embeds: [E('Roblox unavailable', friendly(e))] });
  }
  if (!robloxUser) return ctx.reply({ embeds: [E('Roblox user not found', `No Roblox user named \`${robloxUsername}\`.`)] });

  const existingLink = db.getLinkByRoblox(robloxUser.id);
  if (existingLink) {
    return ctx.reply({ embeds: [E('Roblox account already linked', `**${robloxUser.name}** is already linked to <@${existingLink.discord_id}>.`)] });
  }

  try {
    db.insertLink({ discord_id: discordId, roblox_id: robloxUser.id, roblox_name: robloxUser.name });
  } catch {
    return ctx.reply({ embeds: [E('Could not link account', 'That Discord or Roblox account was linked by another request. Check the existing link and try again.')] });
  }
  db.addAudit({
    discord_id: discordId,
    roblox_id: robloxUser.id,
    action: 'account_manual_link',
    next: `${robloxUser.name} (${robloxUser.id})`,
    staff_id: ctx.user.id,
  });

  let sync;
  try { sync = await access.syncMember(ctx.guild, discordId, { staffId: ctx.user.id }); } catch (e) {
    sync = { ok: false, error: `The account was linked, but access sync failed: ${friendly(e)}` };
  }
  const link = db.getLink(discordId);
  const confirmation = E('Manual Roblox link created', `<@${discordId}> is linked to **${robloxUser.name}**.\nThis staff action does not prove ownership of the Roblox account.`);
  return ctx.reply({ embeds: [confirmation, syncEmbed(sync, link)] });
});

def('checkuser', 1, async ctx => {
  const t = await resolveTarget(ctx.args[0]); const l = t && db.getLink(t);
  if (!l) return ctx.reply({ embeds: [E('Not found', 'No linked account for that member.')] });
  return ctx.reply({ embeds: [E('Linked account').addFields(
    { name: 'Discord', value: `<@${l.discord_id}> (${l.discord_id})` }, { name: 'Roblox', value: `${l.roblox_name} (${l.roblox_id})`, inline: true },
    { name: 'Tier', value: tName(l.current_tier), inline: true }, { name: 'Staff-approved tier', value: l.manual_tier ? tName(l.manual_tier) : 'None', inline: true },
    { name: 'Verified', value: ts(l.verified_at), inline: true }, { name: 'Last checked', value: ts(l.last_checked), inline: true })] });
});

def('pending', 1, ctx => {
  const rows = db.pendingReviews();
  return ctx.reply({ embeds: [E('Pending reviews', rows.length ? rows.slice(0, 15).map(r => `**#${r.id}** <@${r.discord_id}> — ${r.roblox_name} (${r.roblox_id})\nRequested: **${tName(r.requested_tier)}** • ${ts(r.created_at)}\nReason: ${r.reason.slice(0, 200)}`).join('\n\n') : 'No pending reviews.')] });
});

def('approve', 1, async ctx => {
  const r = await access.approveReview(ctx.guild, ctx.args[0], ctx.user.id, ctx.args.slice(1).join(' '));
  return ctx.reply({ embeds: [E(r.ok ? 'Review approved (staff-approved access)' : 'Cannot approve', r.ok ? `#${r.review.id} → **${r.tier.name}** for <@${r.review.discord_id}>.` : r.error)] });
});
def('deny', 1, async ctx => {
  const r = await access.denyReview(ctx.guild, ctx.args[0], ctx.user.id, ctx.args.slice(1).join(' '));
  return ctx.reply({ embeds: [E(r.ok ? 'Review denied' : 'Cannot deny', r.ok ? `#${r.review.id} denied; the member was notified.` : r.error)] });
});
def('recheck', 1, async ctx => {
  const t = await resolveTarget(ctx.args[0]); const l = t && db.getLink(t);
  if (!l) return ctx.reply({ embeds: [E('Not found', 'No linked account for that member.')] });
  return ctx.reply({ embeds: [syncEmbed(await access.syncMember(ctx.guild, t, { staffId: ctx.user.id }), l)] });
});
def('syncroles', 1, async ctx => {
  if (ctx.args[0]) return cmds.recheck.run(ctx);
  await ctx.reply({ embeds: [E('Full sync started', `Syncing ${db.allLinks().length} linked members (throttled for Roblox rate limits). I'll post when finished.`)] });
  const s = await access.syncAll(ctx.guild, ctx.user.id);
  return ctx.send({ embeds: [E(s.ok ? 'Full sync finished' : 'Sync not started', s.ok ? `${s.done}/${s.total} succeeded, ${s.failed} failed (see \`.audit\`).` : s.error)] });
});
def('audit', 1, async ctx => {
  const t = ctx.args[0] ? await resolveTarget(ctx.args[0]) : null;
  const rows = db.recentAudit(15, { discord_id: t || undefined });
  return ctx.reply({ embeds: [E('Audit log', rows.length ? rows.map(a => `${ts(a.at)} **${a.action}** ${a.discord_id ? `<@${a.discord_id}>` : ''}${a.prev_value ? ` | ${a.prev_value}` : ''}${a.next_value ? ` → ${a.next_value}` : ''}${a.staff_id ? ` (by <@${a.staff_id}>)` : ''}`.slice(0, 300)).join('\n') : 'No entries.')] });
});

/* ---------------- admin config commands ---------------- */
function editTier(ctx, key, field, value) {
  const t = db.getTier(key);
  if (!t) return ctx.reply({ embeds: [E('Unknown tier', `Tier \`${key}\` does not exist. Tiers: ${db.getTiers().map(x => x.key).join(', ')}`)] });
  db.updateTier(t.key, { [field]: value });
  db.addAudit({ action: 'config_edit', prev: `${t.key}.${field}=${t[field]}`, next: `${t.key}.${field}=${value}`, staff_id: ctx.user.id });
  return ctx.reply({ embeds: [E('Configuration updated', `**${t.name}** · \`${field}\`: \`${t[field]}\` → \`${value}\``)] });
}
const bad = (ctx, m) => ctx.reply({ embeds: [E('Invalid value', m)] });
const roleId = s => (s || '').match(/^<@&(\d+)>$/)?.[1] || ((s || '').match(/^\d{15,20}$/) ? s : null);

def('setshirt', 2, ctx => /^\d{5,20}$/.test(ctx.args[1] || '') ? editTier(ctx, ctx.args[0], 'shirt_id', ctx.args[1]) : bad(ctx, 'Usage: `.setshirt <tier> <numeric asset id>`'));
def('setrole', 2, ctx => {
  const id = roleId(ctx.args[1]);
  if (!id) return bad(ctx, 'Usage: `.setrole <tier> <@role or role id>`');
  if (!ctx.guild.roles.cache.has(id)) return bad(ctx, 'That role does not exist in this server.');
  return editTier(ctx, ctx.args[0], 'discord_role_id', id);
});
def('setrank', 2, async ctx => {
  if (!/^\d{3,20}$/.test(ctx.args[1] || '')) return bad(ctx, 'Usage: `.setrank <tier> <roblox group role id>`');
  try { if (!(await roblox.getGroupRoles()).some(r => String(r.id) === ctx.args[1])) return bad(ctx, `Role ${ctx.args[1]} does not exist in Roblox group ${cfg.GROUP_ID}.`); } catch (e) { return bad(ctx, 'Could not verify the role with Roblox: ' + friendly(e)); }
  return editTier(ctx, ctx.args[0], 'group_role_id', ctx.args[1]);
});
def('editaccess', 2, ctx => {
  const [key, field, ...v] = ctx.args; const value = v.join(' ');
  if (!['name', 'description', 'priority'].includes(field) || !value) return bad(ctx, 'Usage: `.editaccess <tier> <name|description|priority> <value>`');
  if (field === 'priority' && !/^\d{1,3}$/.test(value)) return bad(ctx, 'Priority must be a whole number.');
  return editTier(ctx, key, field, field === 'priority' ? Number(value) : value);
});
def('addaccess', 2, ctx => {
  const [key, pr, shirt, grp, role, ...nm] = ctx.args; const name = nm.join(' ');
  const rid = roleId(role);
  if (!/^[a-z0-9_-]{2,20}$/i.test(key || '') || !/^\d{1,3}$/.test(pr || '') || !/^\d{5,20}$/.test(shirt || '') || !/^\d{3,20}$/.test(grp || '') || !rid || !name)
    return bad(ctx, 'Usage: `.addaccess <key> <priority> <shirtId> <groupRoleId> <@role> <Display Name>`');
  if (db.getTier(key)) return bad(ctx, 'A tier with that key already exists.');
  if (!ctx.guild.roles.cache.has(rid)) return bad(ctx, 'That Discord role does not exist.');
  db.addTier({ key: key.toLowerCase(), name, priority: Number(pr), shirt_id: shirt, group_role_id: grp, discord_role_id: rid });
  db.addAudit({ action: 'config_add_tier', next: `${key} p${pr} shirt=${shirt} grp=${grp} role=${rid}`, staff_id: ctx.user.id });
  return ctx.reply({ embeds: [E('Tier added', `**${name}** added at priority ${pr}.`)] });
});
def('removeaccess', 2, ctx => {
  const t = db.getTier(ctx.args[0]);
  if (!t) return bad(ctx, 'Unknown tier.');
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rmtier:${t.key}:${ctx.user.id}`).setLabel(`Remove ${t.name}`).setStyle(ButtonStyle.Danger));
  return ctx.reply({ embeds: [E('Remove tier from configuration?', `**${t.name}** will no longer be checked or managed. Members already holding its Discord role keep it until changed manually.`)], components: [row] });
});
async function confirmRemoveTier(interaction) {
  const [, key, uid] = interaction.customId.split(':');
  if (interaction.user.id !== uid || level(interaction.member) < 2) return interaction.reply({ content: 'Not allowed.', ephemeral: true });
  const t = db.getTier(key); if (!t) return interaction.reply({ content: 'Already removed.', ephemeral: true });
  db.deleteTier(key);
  db.addAudit({ action: 'config_remove_tier', prev: JSON.stringify(t), staff_id: uid });
  return interaction.update({ embeds: [E('Tier removed', `**${t.name}** was removed from configuration.`)], components: [] });
}
def('setpolicy', 3, ctx => {
  const v = (ctx.args[0] || '').toLowerCase();
  if (!['keep', 'remove'].includes(v)) return bad(ctx, 'Usage: `.setpolicy <keep|remove>` — what to do when a verified check finds no shirts.');
  const prev = db.getSetting('no_shirt_policy'); db.setSetting('no_shirt_policy', v);
  db.addAudit({ action: 'config_edit', prev: `no_shirt_policy=${prev}`, next: `no_shirt_policy=${v}`, staff_id: ctx.user.id });
  return ctx.reply({ embeds: [E('Policy updated', `No-shirt policy: **${v}**`)] });
});

module.exports = { cmds, startVerify, confirmVerify, confirmUnlink, confirmRemoveTier };
