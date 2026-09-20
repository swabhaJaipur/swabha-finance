// Single-admin now, multi-user ready. Passwords are scrypt-hashed (node:crypto,
// no native deps). Sessions are server-side rows + an HMAC-signed cookie.
const crypto = require('node:crypto');
const { all, get, run } = require('./db');

const COOKIE = 'swabha_sid';
const DAYS = 14;

function secret() {
  let s = get('SELECT value FROM settings WHERE key=?', ['session_secret']);
  if (!s) {
    const v = crypto.randomBytes(32).toString('hex');
    run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', ['session_secret', v]);
    return v;
  }
  return s.value;
}

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function createUser({ username, fullName, password, perms }) {
  const salt = crypto.randomBytes(16).toString('hex');
  run(`INSERT INTO users(username,full_name,pw_hash,pw_salt,perms) VALUES(?,?,?,?,?)`,
      [username, fullName || username, hash(password, salt), salt, perms || 'finance.admin']);
  return get('SELECT user_id,username,full_name,perms FROM users WHERE username=?', [username]);
}

function verify(username, password) {
  const u = get('SELECT * FROM users WHERE username=? AND active=1', [username]);
  if (!u) return null;
  const a = Buffer.from(hash(password, u.pw_salt), 'hex');
  const b = Buffer.from(u.pw_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  run("UPDATE users SET last_login=datetime('now') WHERE user_id=?", [u.user_id]);
  return u;
}

const sign = sid => crypto.createHmac('sha256', secret()).update(sid).digest('hex').slice(0, 32);

function startSession(userId, ip) {
  const sid = crypto.randomBytes(24).toString('hex');
  run(`INSERT INTO sessions(sid,user_id,expires_at,ip)
       VALUES(?,?,datetime('now','+${DAYS} days'),?)`, [sid, userId, ip || null]);
  return `${sid}.${sign(sid)}`;
}

function userFromCookie(header) {
  const m = /(?:^|;\s*)swabha_sid=([^;]+)/.exec(header || '');
  if (!m) return null;
  const [sid, sig] = decodeURIComponent(m[1]).split('.');
  if (!sid || !sig) return null;
  const expect = sign(sid);
  if (sig.length !== expect.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const s = get(`SELECT u.user_id,u.username,u.full_name,u.perms FROM sessions s
                 JOIN users u USING(user_id)
                 WHERE s.sid=? AND s.expires_at > datetime('now') AND u.active=1`, [sid]);
  return s || null;
}

function endSession(header) {
  const m = /(?:^|;\s*)swabha_sid=([^;]+)/.exec(header || '');
  if (m) run('DELETE FROM sessions WHERE sid=?', [decodeURIComponent(m[1]).split('.')[0]]);
}

const PERMS = [
  ['finance.view',    'See dashboards and reports'],
  ['finance.entry',   'Post new entries and import data'],
  ['finance.edit',    'Correct existing entries'],
  ['finance.masters', 'Change rates, mappings and fixed monthly items'],
  ['finance.admin',   'Everything, including managing people'],
];

function setPassword(userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE users SET pw_hash=?, pw_salt=? WHERE user_id=?', [hash(password, salt), salt, userId]);
  run('DELETE FROM sessions WHERE user_id=?', [userId]);   // force re-login everywhere
}
const adminCount = () =>
  all("SELECT user_id FROM users WHERE active=1 AND perms LIKE '%finance.admin%'").length;

const can = (user, perm) =>
  !!user && (user.perms.includes('finance.admin') || user.perms.split(',').includes(perm));

module.exports = { COOKIE, DAYS, PERMS, createUser, verify, startSession, userFromCookie, endSession,
                   can, setPassword, adminCount,
                   hasAnyUser: () => !!get('SELECT 1 AS x FROM users LIMIT 1') };
