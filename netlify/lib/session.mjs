// Signed, HttpOnly cookies (HMAC-SHA256). No session database needed.
//   cc_session  -> the account currently signed in
//   cc_accounts -> every account that has signed in on this browser, so you can
//                  switch between them without going through Discord again
import crypto from 'node:crypto';

const COOKIE = 'cc_session';
const ACCOUNTS = 'cc_accounts';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const MAX_ACCOUNTS = 5;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET env var is missing or too short (use 32+ random characters)');
  return s;
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

/** A signature for links that must work without a login (like calendar feeds). */
export const signLink = (purpose, data) => sign(`${purpose}:${data}`).slice(0, 32);
export const checkLink = (purpose, data, sig) => {
  const expected = signLink(purpose, data);
  return typeof sig === 'string' && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
};

function seal(data) {
  const payload = b64(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + MAX_AGE }));
  return `${payload}.${sign(payload)}`;
}

function unseal(raw) {
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp < Date.now() / 1000 ? null : data;
  } catch {
    return null;
  }
}

const cookie = (name, value, secure, maxAge = MAX_AGE) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSessionCookie(uid, secure = true) {
  return cookie(COOKIE, seal({ uid }), secure);
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readSession(req) {
  return unseal(parseCookies(req)[COOKIE])?.uid || null;
}

/** Account IDs remembered on this browser, most recently used first. */
export function readAccounts(req) {
  const ids = unseal(parseCookies(req)[ACCOUNTS])?.uids;
  return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
}

export function accountsCookie(uids, secure = true) {
  const list = [...new Set(uids)].slice(0, MAX_ACCOUNTS);
  if (!list.length) return `${ACCOUNTS}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return cookie(ACCOUNTS, seal({ uids: list }), secure);
}
