const express = require('express');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const roblox = require('./roblox');
const access = require('./access');
const { level } = require('./util');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = ms => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
const tn = k => db.getTier(k)?.name || k || 'None';

const CSS = `*{box-sizing:border-box}body{margin:0;background:#0a0a0a;color:#eee;font:15px system-ui,sans-serif}
header{background:#c8102e;padding:14px 24px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}header b{font-size:18px;letter-spacing:1px}
header a{color:#fff;text-decoration:none;opacity:.85}header a:hover{opacity:1;text-decoration:underline}.sp{flex:1}
main{max-width:1100px;margin:24px auto;padding:0 16px}h1,h2{color:#ff2a4a;margin-top:0}
.card{background:#141414;border:1px solid #2a2a2a;border-left:4px solid #c8102e;border-radius:6px;padding:16px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat{font-size:28px;font-weight:700;color:#fff}.muted{color:#999;font-size:13px}
table{width:100%;border-collapse:collapse}td,th{padding:7px 8px;border-bottom:1px solid #262626;text-align:left;vertical-align:top;font-size:14px}th{color:#ff2a4a}
input,select,textarea{background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px;padding:7px;width:100%;margin:3px 0 8px}
button{background:#c8102e;color:#fff;border:0;border-radius:4px;padding:8px 14px;cursor:pointer;font-weight:600}button:hover{background:#e0122f}button.alt{background:#333}
.flash{background:#2a0a10;border:1px solid #c8102e;padding:10px 14px;border-radius:6px;margin-bottom:16px}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.ok{color:#4ade80}.bad{color:#ff5a6e}`;

function start(client) {
  if (!cfg.SESSION_SECRET || cfg.SESSION_SECRET.length < 16 || !cfg.CLIENT_SECRET) { console.warn('Dashboard disabled: set SESSION_SECRET (16+ chars) and DISCORD_CLIENT_SECRET.'); return; }
  const app = express();
  const guild = () => client.guilds.cache.get(cfg.GUILD_ID);
  app.disable('x-powered-by');
  if (cfg.DASHBOARD_URL.startsWith('https')) app.set('trust proxy', 1);
  app.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'", 'Cache-Control': 'no-store' }); next(); });
  app.use(cookieSession({ name: 'wnm', keys: [cfg.SESSION_SECRET], maxAge: 2 * 3600e3, httpOnly: true, sameSite: 'lax', secure: cfg.DASHBOARD_URL.startsWith('https') }));
  app.use(express.urlencoded({ extended: false }));

  const page = (req, title, body) => {
    const u = req.session.user, flash = req.session.flash; req.session.flash = null;
    return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)} · WNM</title><style>${CSS}</style>
<header><b>WNM ACCESS</b>${u ? `<a href=/>Dashboard</a><a href=/members>Members</a><a href=/tiers>Tiers</a><a href=/reviews>Reviews</a><a href=/logs/audit>Audit</a><a href=/logs/ranking>Ranking</a><a href=/logs/verifications>Verifications</a>${u.level >= 3 ? '<a href=/owner>Owner</a>' : ''}<span class=sp></span><span class=muted style=color:#fff>${esc(u.name)}</span><a href=/logout>Logout</a>` : ''}</header>
<main>${flash ? `<div class=flash>${esc(flash)}</div>` : ''}${body}</main>`;
  };
  const csrf = req => `<input type=hidden name=_csrf value="${esc((req.session.csrf ||= crypto.randomBytes(16).toString('hex')))}">`;
  const need = lvl => (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.level < lvl) return res.status(403).send(page(req, 'Forbidden', '<h1>Forbidden</h1><p>You do not have access to this section.</p>'));
    if (req.method === 'POST') {
      const a = Buffer.from(String(req.body._csrf || '')), b = Buffer.from(req.session.csrf || '');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('Bad CSRF token');
    }
    next();
  };
  const back = (req, res, msg, to) => { req.session.flash = msg; res.redirect(to || req.get('referer') || '/'); };
  const pinOk = p => cfg.OWNER_PIN && p && p.length === cfg.OWNER_PIN.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(cfg.OWNER_PIN));

  /* ---- auth (Discord OAuth2) ---- */
  app.get('/login', (req, res) => {
    req.session.state = crypto.randomBytes(16).toString('hex');
    res.redirect('https://discord.com/api/oauth2/authorize?' + new URLSearchParams({ client_id: cfg.CLIENT_ID, redirect_uri: cfg.DASHBOARD_URL + '/callback', response_type: 'code', scope: 'identify', state: req.session.state }));
  });
  app.get('/callback', async (req, res) => {
    try {
      if (!req.query.code || req.query.state !== req.session.state) return res.status(400).send('Invalid login state');
      const t = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.CLIENT_ID, client_secret: cfg.CLIENT_SECRET, grant_type: 'authorization_code', code: req.query.code, redirect_uri: cfg.DASHBOARD_URL + '/callback' }) })).json();
      const me = await (await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${t.access_token}` } })).json();
      const m = await guild().members.fetch(me.id).catch(() => null);
      const lv = level(m);
      if (lv < 1) return res.status(403).send('Staff access required.');
      req.session = { user: { id: me.id, name: me.username, level: lv }, csrf: crypto.randomBytes(16).toString('hex') };
      res.redirect('/');
    } catch (e) { console.error(e); res.status(500).send('Login failed'); }
  });
  app.get('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

  /* ---- main ---- */
  app.get('/', need(1), (req, res) => {
    const c = Object.fromEntries(db.countsByTier().map(r => [r.t || '_', r.c]));
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const rs = roblox.state;
    res.send(page(req, 'Dashboard', `<h1>Dashboard</h1>
<div class=grid><div class=card><div class=muted>Verified members</div><div class=stat>${total}</div></div>
${db.getTiers().slice().reverse().map(t => `<div class=card><div class=muted>${esc(t.name)}</div><div class=stat>${c[t.key] || 0}</div></div>`).join('')}
<div class=card><div class=muted>No tier</div><div class=stat>${c._ || 0}</div></div><div class=card><div class=muted>Pending reviews</div><div class=stat>${db.pendingReviews().length}</div></div></div>
<div class=card><h2>Status</h2><p>Bot: <span class=ok>online</span> · ping ${client.ws.ping}ms · uptime ${Math.floor(process.uptime() / 60)} min</p>
<p>Roblox API (last request): <span class="${rs.ok === false ? 'bad' : 'ok'}">${rs.ok === null ? 'no requests yet' : esc(rs.message)}</span> <span class=muted>${when(rs.at)}</span></p>
<p>Roblox rank changes: ${cfg.OPEN_CLOUD_KEY ? '<span class=ok>API key configured</span>' : '<span class=bad>no API key — ranks cannot be changed</span>'}</p>
<form method=post action=/roblox-test>${csrf(req)}<button class=alt>Test Roblox connection</button></form></div>
<div class=card><h2>Role synchronization</h2><form method=post action=/sync-all>${csrf(req)}<button>Sync all linked members</button></form><p class=muted>Throttled; check Audit for the summary.</p></div>`));
  });
  app.post('/roblox-test', need(1), async (req, res) => back(req, res, (await roblox.ping()) ? 'Roblox API reachable.' : 'Roblox API NOT reachable.', '/'));
  app.post('/sync-all', need(1), (req, res) => {
    access.syncAll(guild(), req.session.user.id).catch(e => console.error(e));
    back(req, res, 'Full sync started in the background.', '/');
  });

  /* ---- members ---- */
  app.get('/members', need(1), (req, res) => {
    const q = String(req.query.q || '').trim();
    const rows = q ? db.searchLinks(q) : db.raw.prepare('SELECT * FROM links ORDER BY verified_at DESC LIMIT 50').all();
    res.send(page(req, 'Members', `<h1>Members</h1><form class=card><input name=q placeholder="Discord ID or Roblox username" value="${esc(q)}"><button>Search</button></form>
<div class=card><table><tr><th>Discord ID</th><th>Roblox</th><th>Tier</th><th>Verified</th></tr>${rows.map(l => `<tr><td><a style=color:#ff2a4a href=/member/${esc(l.discord_id)}>${esc(l.discord_id)}</a></td><td>${esc(l.roblox_name)} (${esc(l.roblox_id)})</td><td>${esc(tn(l.current_tier))}${l.manual_tier ? ' *' : ''}</td><td>${when(l.verified_at)}</td></tr>`).join('') || '<tr><td colspan=4>No results</td></tr>'}</table></div>`));
  });
  app.get('/member/:id', need(1), (req, res) => {
    const l = db.getLink(req.params.id);
    if (!l) return res.status(404).send(page(req, 'Not found', '<h1>Not found</h1>'));
    res.send(page(req, 'Member', `<h1>${esc(l.roblox_name)}</h1><div class=card><p>Discord: ${esc(l.discord_id)}<br>Roblox ID: ${esc(l.roblox_id)} · <a style=color:#ff2a4a href="https://www.roblox.com/users/${esc(l.roblox_id)}/profile" target=_blank rel=noopener>profile</a><br>Tier: <b>${esc(tn(l.current_tier))}</b>${l.manual_tier ? ` (staff-approved: ${esc(tn(l.manual_tier))})` : ''}<br>Verified: ${when(l.verified_at)} · Last checked: ${when(l.last_checked)}</p>
<form method=post action=/member/${esc(l.discord_id)}/recheck>${csrf(req)}<button>Recheck inventory &amp; sync</button></form></div>
<div class=card><h2>Ranking history</h2><table>${db.history(l.discord_id, 25).map(h => `<tr><td>${when(h.at)}</td><td>${esc(tn(h.from_tier))} → ${esc(tn(h.to_tier))}</td><td>${esc(h.source)}</td></tr>`).join('') || '<tr><td>None</td></tr>'}</table></div>
<div class=card><h2>Audit</h2>${auditTable(db.recentAudit(30, { discord_id: l.discord_id }))}</div>`));
  });
  app.post('/member/:id/recheck', need(1), async (req, res) => {
    const r = await access.syncMember(guild(), req.params.id, { staffId: req.session.user.id });
    back(req, res, r.ok ? `Synced. Tier: ${r.tier ? r.tier.name : 'none'}` : r.error.replace(/\*/g, ''));
  });

  /* ---- tiers ---- */
  app.get('/tiers', need(1), (req, res) => {
    const admin = req.session.user.level >= 2;
    res.send(page(req, 'Tiers', `<h1>Access tiers</h1>${db.getTiers().slice().reverse().map(t => `<form class=card method=post action=/tiers/${esc(t.key)}>${csrf(req)}<h2>${esc(t.name)} <span class=muted>(${esc(t.key)})</span></h2><div class=row>
<div>Name<input name=name value="${esc(t.name)}" ${admin ? '' : 'disabled'}></div><div>Priority<input name=priority value="${t.priority}" ${admin ? '' : 'disabled'}></div>
<div>Shirt asset ID<input name=shirt_id value="${esc(t.shirt_id)}" ${admin ? '' : 'disabled'}></div><div>Roblox group role ID<input name=group_role_id value="${esc(t.group_role_id)}" ${admin ? '' : 'disabled'}></div>
<div>Discord role ID<input name=discord_role_id value="${esc(t.discord_role_id)}" ${admin ? '' : 'disabled'}></div></div>Description<input name=description value="${esc(t.description)}" ${admin ? '' : 'disabled'}>
${admin ? `<button>Save</button> <button class=alt formaction=/tiers/${esc(t.key)}/delete onclick="return confirm('Remove this tier from configuration?')">Remove</button>` : ''}</form>`).join('')}
${admin ? `<form class=card method=post action=/tiers/new>${csrf(req)}<h2>Add tier</h2><div class=row><div>Key<input name=key required pattern="[a-z0-9_-]{2,20}"></div><div>Name<input name=name required></div><div>Priority<input name=priority required></div><div>Shirt asset ID<input name=shirt_id required></div><div>Group role ID<input name=group_role_id required></div><div>Discord role ID<input name=discord_role_id required></div></div><button>Add</button></form>` : ''}`));
  });
  const validTier = (b, g) => {
    if (!b.name || !/^\d{1,3}$/.test(b.priority) || !/^\d{5,20}$/.test(b.shirt_id) || !/^\d{3,20}$/.test(b.group_role_id) || !/^\d{15,20}$/.test(b.discord_role_id)) return 'Invalid field format.';
    if (!g.roles.cache.has(b.discord_role_id)) return 'That Discord role does not exist in the server.';
    return null;
  };
  app.post('/tiers/new', need(2), (req, res) => {
    const b = req.body, err = validTier(b, guild()) || (!/^[a-z0-9_-]{2,20}$/.test(b.key || '') ? 'Bad key.' : db.getTier(b.key) ? 'Key exists.' : null);
    if (err) return back(req, res, err, '/tiers');
    db.addTier({ key: b.key, name: b.name.slice(0, 40), description: '', priority: Number(b.priority), shirt_id: b.shirt_id, group_role_id: b.group_role_id, discord_role_id: b.discord_role_id });
    db.addAudit({ action: 'config_add_tier', next: JSON.stringify({ ...b, _csrf: undefined }), staff_id: req.session.user.id });
    back(req, res, 'Tier added.', '/tiers');
  });
  app.post('/tiers/:key', need(2), (req, res) => {
    const t = db.getTier(req.params.key); if (!t) return back(req, res, 'Unknown tier.', '/tiers');
    const b = req.body, err = validTier(b, guild()); if (err) return back(req, res, err, '/tiers');
    const next = { name: b.name.slice(0, 40), description: (b.description || '').slice(0, 200), priority: Number(b.priority), shirt_id: b.shirt_id, group_role_id: b.group_role_id, discord_role_id: b.discord_role_id };
    db.updateTier(t.key, next);
    db.addAudit({ action: 'config_edit', prev: JSON.stringify(t), next: JSON.stringify(next), staff_id: req.session.user.id });
    back(req, res, 'Saved.', '/tiers');
  });
  app.post('/tiers/:key/delete', need(2), (req, res) => {
    const t = db.getTier(req.params.key); if (!t) return back(req, res, 'Unknown tier.', '/tiers');
    db.deleteTier(t.key); db.addAudit({ action: 'config_remove_tier', prev: JSON.stringify(t), staff_id: req.session.user.id });
    back(req, res, 'Tier removed.', '/tiers');
  });

  /* ---- reviews ---- */
  app.get('/reviews', need(1), (req, res) => {
    const p = db.pendingReviews();
    res.send(page(req, 'Reviews', `<h1>Pending manual reviews</h1>${p.map(r => `<div class=card><b>#${r.id}</b> ${esc(r.roblox_name)} (${esc(r.roblox_id)}) · Discord ${esc(r.discord_id)}<br>Requested: <b>${esc(tn(r.requested_tier))}</b> · ${when(r.created_at)}<p>${esc(r.reason)}</p>
<form method=post action=/reviews/${r.id}/approve>${csrf(req)}<input name=note placeholder="Approval note (recorded)"><button>Approve (staff-approved access)</button></form>
<form method=post action=/reviews/${r.id}/deny>${csrf(req)}<input name=reason placeholder="Denial reason (required)" required><button class=alt>Deny</button></form></div>`).join('') || '<div class=card>None pending.</div>'}
<h2>Recently reviewed</h2><div class=card><table>${db.recentReviews().map(r => `<tr><td>#${r.id}</td><td>${esc(r.roblox_name)}</td><td>${esc(tn(r.requested_tier))}</td><td>${esc(r.status)}</td><td>${esc(r.reviewed_by)}</td><td>${esc(r.note)}</td></tr>`).join('')}</table></div>`));
  });
  app.post('/reviews/:id/approve', need(1), async (req, res) => { const r = await access.approveReview(guild(), req.params.id, req.session.user.id, String(req.body.note || '').slice(0, 300)); back(req, res, r.ok ? 'Approved.' : r.error, '/reviews'); });
  app.post('/reviews/:id/deny', need(1), async (req, res) => { const r = await access.denyReview(guild(), req.params.id, req.session.user.id, String(req.body.reason || '').slice(0, 300)); back(req, res, r.ok ? 'Denied.' : r.error, '/reviews'); });

  /* ---- logs (read-only) ---- */
  function auditTable(rows) {
    return `<table><tr><th>Time</th><th>Action</th><th>Discord</th><th>Roblox</th><th>Previous</th><th>New</th><th>Staff</th></tr>${rows.map(a => `<tr><td>${when(a.at)}</td><td>${esc(a.action)}</td><td>${esc(a.discord_id)}</td><td>${esc(a.roblox_id)}</td><td>${esc(a.prev_value)}</td><td>${esc(a.next_value)}</td><td>${esc(a.staff_id)}</td></tr>`).join('') || '<tr><td colspan=7>No entries</td></tr>'}</table>`;
  }
  app.get('/logs/:type', need(1), (req, res) => {
    const t = req.params.type; let body;
    if (t === 'audit') body = auditTable(db.recentAudit(300));
    else if (t === 'verifications') body = auditTable(db.recentAudit(300, { like: ['verify%', 'account_%'] }));
    else if (t === 'ranking') body = `<table><tr><th>Time</th><th>Discord</th><th>Roblox</th><th>Change</th><th>Source</th></tr>${db.allHistory(300).map(h => `<tr><td>${when(h.at)}</td><td>${esc(h.discord_id)}</td><td>${esc(h.roblox_id)}</td><td>${esc(tn(h.from_tier))} → ${esc(tn(h.to_tier))}</td><td>${esc(h.source)}</td></tr>`).join('')}</table>`;
    else return res.status(404).send('Not found');
    res.send(page(req, t, `<h1>${esc(t[0].toUpperCase() + t.slice(1))} log</h1><div class=card style=overflow-x:auto>${body}</div><p class=muted>Read-only. Audit records cannot be edited or deleted.</p>`));
  });

  /* ---- owner-only ---- */
  app.get('/owner', need(3), (req, res) => {
    res.send(page(req, 'Owner', `<h1>Owner settings</h1><p class=muted>Every action here requires the owner PIN.</p>
<form class=card method=post action=/owner/policy>${csrf(req)}<h2>No-shirt policy</h2><p class=muted>When a verified check finds no shirts: keep existing access, or remove it.</p>
<select name=policy><option ${db.getSetting('no_shirt_policy') === 'keep' ? 'selected' : ''}>keep</option><option ${db.getSetting('no_shirt_policy') === 'remove' ? 'selected' : ''}>remove</option></select><input type=password name=pin placeholder="Owner PIN" required><button>Save</button></form>
<form class=card method=post action=/owner/backup>${csrf(req)}<h2>Database backup</h2><p class=muted>Latest: ${esc(db.listBackups().slice(0, 5).join(', ') || 'none')}</p><input type=password name=pin placeholder="Owner PIN" required><button>Back up now</button></form>
<form class=card method=post action=/owner/forceunlink>${csrf(req)}<h2>Force-unlink a member</h2><input name=discord_id placeholder="Discord ID" required><input type=password name=pin placeholder="Owner PIN" required><button>Force unlink</button></form>`));
  });
  app.post('/owner/policy', need(3), (req, res) => {
    if (!pinOk(req.body.pin)) return back(req, res, 'Wrong PIN.', '/owner');
    if (!['keep', 'remove'].includes(req.body.policy)) return back(req, res, 'Invalid policy.', '/owner');
    const prev = db.getSetting('no_shirt_policy'); db.setSetting('no_shirt_policy', req.body.policy);
    db.addAudit({ action: 'config_edit', prev: `no_shirt_policy=${prev}`, next: `no_shirt_policy=${req.body.policy}`, staff_id: req.session.user.id });
    back(req, res, 'Saved.', '/owner');
  });
  app.post('/owner/backup', need(3), async (req, res) => {
    if (!pinOk(req.body.pin)) return back(req, res, 'Wrong PIN.', '/owner');
    await db.backupNow(); db.addAudit({ action: 'backup', staff_id: req.session.user.id }); back(req, res, 'Backup created.', '/owner');
  });
  app.post('/owner/forceunlink', need(3), async (req, res) => {
    if (!pinOk(req.body.pin)) return back(req, res, 'Wrong PIN.', '/owner');
    const ok = await access.unlinkMember(guild(), String(req.body.discord_id).trim(), req.session.user.id);
    back(req, res, ok ? 'Member unlinked.' : 'No such linked member.', '/owner');
  });

  app.listen(cfg.PORT, () => console.log(`Dashboard on ${cfg.DASHBOARD_URL} (port ${cfg.PORT})`));
}
module.exports = { start };
