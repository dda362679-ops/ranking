const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

fs.mkdirSync(path.join(cfg.DATA_DIR, 'backups'), { recursive: true });
const db = new Database(path.join(cfg.DATA_DIR, 'wnm.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS tiers (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL, shirt_id TEXT NOT NULL, group_role_id TEXT NOT NULL, discord_role_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links (
  discord_id TEXT PRIMARY KEY, roblox_id TEXT NOT NULL UNIQUE, roblox_name TEXT NOT NULL,
  verified_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'verified',
  current_tier TEXT, manual_tier TEXT, last_checked INTEGER);
CREATE TABLE IF NOT EXISTS pending (
  discord_id TEXT PRIMARY KEY, roblox_id TEXT NOT NULL, roblox_name TEXT NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT NOT NULL, roblox_id TEXT NOT NULL, roblox_name TEXT NOT NULL,
  requested_tier TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, reviewed_by TEXT, reviewed_at INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT NOT NULL, roblox_id TEXT,
  from_tier TEXT, to_tier TEXT, source TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT, roblox_id TEXT, action TEXT NOT NULL,
  prev_value TEXT, next_value TEXT, staff_id TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Audit log is append-only at the database level.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`);

if (!db.prepare('SELECT COUNT(*) c FROM tiers').get().c) {
  const ins = db.prepare('INSERT INTO tiers (key,name,description,priority,shirt_id,group_role_id,discord_role_id) VALUES (?,?,?,?,?,?,?)');
  for (const t of cfg.DEFAULT_TIERS) ins.run(t.key, t.name, '', t.priority, t.shirt_id, t.group_role_id, t.discord_role_id);
}
db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('no_shirt_policy','keep')").run();

const LINK_COLS = ['roblox_id', 'roblox_name', 'status', 'current_tier', 'manual_tier', 'last_checked'];
const TIER_COLS = ['name', 'description', 'priority', 'shirt_id', 'group_role_id', 'discord_role_id'];

module.exports = {
  raw: db,
  getSetting: k => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value,
  setSetting: (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)),

  getTiers: () => db.prepare('SELECT * FROM tiers ORDER BY priority ASC').all(),
  getTier: k => (k ? db.prepare('SELECT * FROM tiers WHERE key=?').get(String(k).toLowerCase()) : undefined),
  addTier: t => db.prepare('INSERT INTO tiers (key,name,description,priority,shirt_id,group_role_id,discord_role_id) VALUES (?,?,?,?,?,?,?)')
    .run(t.key, t.name, t.description || '', t.priority, t.shirt_id, t.group_role_id, t.discord_role_id),
  updateTier(key, fields) {
    const cols = Object.keys(fields).filter(c => TIER_COLS.includes(c));
    if (!cols.length) return;
    db.prepare(`UPDATE tiers SET ${cols.map(c => c + '=?').join(',')} WHERE key=?`).run(...cols.map(c => fields[c]), key);
  },
  deleteTier: k => db.prepare('DELETE FROM tiers WHERE key=?').run(k),

  getLink: id => db.prepare('SELECT * FROM links WHERE discord_id=?').get(String(id)),
  getLinkByRoblox: rid => db.prepare('SELECT * FROM links WHERE roblox_id=?').get(String(rid)),
  getLinkByName: n => db.prepare('SELECT * FROM links WHERE roblox_name=? COLLATE NOCASE').get(n),
  searchLinks: q => db.prepare('SELECT * FROM links WHERE discord_id=? OR roblox_id=? OR roblox_name LIKE ? ORDER BY verified_at DESC LIMIT 50').all(q, q, `%${q}%`),
  allLinks: () => db.prepare('SELECT * FROM links').all(),
  insertLink: l => db.prepare('INSERT INTO links (discord_id,roblox_id,roblox_name,verified_at) VALUES (?,?,?,?)').run(l.discord_id, l.roblox_id, l.roblox_name, Date.now()),
  updateLink(id, fields) {
    const cols = Object.keys(fields).filter(c => LINK_COLS.includes(c));
    if (!cols.length) return;
    db.prepare(`UPDATE links SET ${cols.map(c => c + '=?').join(',')} WHERE discord_id=?`).run(...cols.map(c => fields[c]), String(id));
  },
  deleteLink: id => db.prepare('DELETE FROM links WHERE discord_id=?').run(String(id)),
  countsByTier: () => db.prepare('SELECT current_tier t, COUNT(*) c FROM links GROUP BY current_tier').all(),

  savePending: p => db.prepare('INSERT INTO pending (discord_id,roblox_id,roblox_name,code,expires) VALUES (?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET roblox_id=excluded.roblox_id, roblox_name=excluded.roblox_name, code=excluded.code, expires=excluded.expires')
    .run(p.discord_id, p.roblox_id, p.roblox_name, p.code, p.expires),
  getPending: id => db.prepare('SELECT * FROM pending WHERE discord_id=?').get(String(id)),
  delPending: id => db.prepare('DELETE FROM pending WHERE discord_id=?').run(String(id)),

  addAudit: e => db.prepare('INSERT INTO audit (discord_id,roblox_id,action,prev_value,next_value,staff_id,at) VALUES (?,?,?,?,?,?,?)')
    .run(e.discord_id || null, e.roblox_id || null, e.action, e.prev == null ? null : String(e.prev), e.next == null ? null : String(e.next), e.staff_id || null, Date.now()),
  recentAudit(limit = 100, { discord_id, like } = {}) {
    const w = [], a = [];
    if (discord_id) { w.push('discord_id=?'); a.push(discord_id); }
    if (like) { w.push('(' + like.map(() => 'action LIKE ?').join(' OR ') + ')'); a.push(...like); }
    return db.prepare(`SELECT * FROM audit ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...a, limit);
  },

  addHistory: h => db.prepare('INSERT INTO history (discord_id,roblox_id,from_tier,to_tier,source,at) VALUES (?,?,?,?,?,?)')
    .run(h.discord_id, h.roblox_id || null, h.from_tier || null, h.to_tier || null, h.source, Date.now()),
  history: (id, limit = 10) => db.prepare('SELECT * FROM history WHERE discord_id=? ORDER BY id DESC LIMIT ?').all(String(id), limit),
  allHistory: (limit = 100) => db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT ?').all(limit),

  createReview: r => db.prepare('INSERT INTO reviews (discord_id,roblox_id,roblox_name,requested_tier,reason,created_at) VALUES (?,?,?,?,?,?)')
    .run(r.discord_id, r.roblox_id, r.roblox_name, r.requested_tier, r.reason, Date.now()).lastInsertRowid,
  getReview: id => db.prepare('SELECT * FROM reviews WHERE id=?').get(id),
  pendingReviewFor: id => db.prepare("SELECT * FROM reviews WHERE discord_id=? AND status='pending'").get(String(id)),
  pendingReviews: () => db.prepare("SELECT * FROM reviews WHERE status='pending' ORDER BY id ASC").all(),
  recentReviews: (n = 30) => db.prepare("SELECT * FROM reviews WHERE status!='pending' ORDER BY id DESC LIMIT ?").all(n),
  finishReview: (id, status, by, note) => db.prepare('UPDATE reviews SET status=?, reviewed_by=?, reviewed_at=?, note=? WHERE id=?').run(status, by, Date.now(), note, id),

  async backupNow() {
    const file = path.join(cfg.DATA_DIR, 'backups', `wnm-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await db.backup(file);
    const files = fs.readdirSync(path.join(cfg.DATA_DIR, 'backups')).filter(f => f.endsWith('.db')).sort();
    for (const old of files.slice(0, -14)) fs.unlinkSync(path.join(cfg.DATA_DIR, 'backups', old));
    return file;
  },
  listBackups: () => fs.readdirSync(path.join(cfg.DATA_DIR, 'backups')).filter(f => f.endsWith('.db')).sort().reverse(),
};
