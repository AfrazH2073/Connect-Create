// Shared constants, validation and visibility rules.
import crypto from 'node:crypto';

export const PLATFORMS = ['youtube', 'twitch', 'tiktok', 'instagram', 'twitter', 'substack'];
// Lobbies are for streams and videos, so text-first platforms aren't offered there.
export const LOBBY_PLATFORMS = ['youtube', 'twitch', 'tiktok', 'instagram'];
// Profile banner colours (the frontend maps each key to a gradient).
export const BANNERS = ['violet', 'blue', 'teal', 'green', 'orange', 'pink', 'red', 'slate'];
export const CATEGORIES = [
  'Gaming', 'IRL', 'Just Chatting', 'STEM', 'Tech', 'Education', 'Beauty', 'Fashion',
  'Music', 'Art', 'Comedy', 'Fitness', 'Cooking', 'Travel', 'ASMR', 'Podcasts',
  'Sports', 'Esports', 'Speedrunning', 'Horror', 'Vlogs', 'Reviews',
];
export const VISIBILITIES = ['public', 'friends', 'private', 'code'];

/**
 * "Needs approval" is an on/off setting on top of Public, Friends or Private
 * (never Code: having the code is enough). Lobbies saved before that change used
 * visibility "approval", which meant Public + approval.
 */
export function normalizeLobby(l) {
  if (!l) return l;
  if (l.visibility === 'approval') { l.visibility = 'public'; l.approval = true; }
  l.approval = l.visibility !== 'code' && l.approval === true;
  l.questions ||= [];
  l.answers ||= {};
  l.waitlist ||= [];
  for (const x of l.sessions || []) x.waitlist ||= [];
  if (l.poll) l.poll.votes ||= {};
  return l;
}

export const newId = () => crypto.randomBytes(9).toString('base64url');
export const newCode = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
export const now = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const fail = (status, message, code, extra) => { throw new HttpError(status, message, code, extra); };

export function str(v, max, { required = false, name = 'field' } = {}) {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  if (required && !s) fail(400, `${name} is required`);
  return s;
}

export function pick(list, allowed, max = 50) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => allowed.includes(x)))].slice(0, max);
}

export function idList(list, max = 100) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x) => typeof x === 'string' && /^\d{5,25}$/.test(x)))].slice(0, max);
}

/** Accept "@handle", "handle", or a full profile URL and return a clean handle. */
export function cleanHandle(platform, input) {
  let s = str(input, 200);
  if (!s) return '';
  try {
    if (/^https?:\/\//i.test(s) || /^(www\.)?[\w-]+(\.[\w-]+)+\//i.test(s) || /^([\w-]+\.)?substack\.com$/i.test(s)) {
      const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      const parts = u.pathname.split('/').filter(Boolean);
      if (platform === 'youtube') {
        const at = parts.find((p) => p.startsWith('@'));
        s = at || (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user' ? parts.slice(0, 2).join('/') : parts[0] || '');
      } else if (platform === 'substack') {
        // name.substack.com, substack.com/@name, or a custom newsletter domain
        if (host.endsWith('.substack.com')) s = host.slice(0, -'.substack.com'.length);
        else if (host === 'substack.com') s = (parts[0] || '').replace(/^@/, '');
        else s = host;
      } else {
        s = parts[0] || '';
      }
    }
  } catch { /* fall through */ }
  s = s.replace(/^@/, '');
  if (platform !== 'youtube') s = s.replace(/\//g, '');
  return s.replace(/[^\w.\-/]/g, '').slice(0, 100);
}

export function platformUrl(platform, handle) {
  if (!handle) return '';
  switch (platform) {
    case 'youtube': return handle.includes('/') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/@${handle}`;
    case 'twitch': return `https://www.twitch.tv/${handle}`;
    case 'tiktok': return `https://www.tiktok.com/@${handle}`;
    case 'instagram': return `https://www.instagram.com/${handle}`;
    case 'twitter': return `https://x.com/${handle}`;
    case 'substack': return handle.includes('.') ? `https://${handle}` : `https://${handle}.substack.com`;
    default: return '';
  }
}

/** Parse a YouTube/Twitch link into something we can embed. */
export function parseMedia(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (/^[\w-]{11}$/.test(id)) return { platform: 'youtube', kind: 'video', mediaId: id };
  }
  if (host === 'youtube.com') {
    let id = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})/);
    if (!id && m) id = m[1];
    if (id && /^[\w-]{11}$/.test(id)) return { platform: 'youtube', kind: 'video', mediaId: id };
  }
  if (host === 'clips.twitch.tv') {
    const slug = u.pathname.slice(1).split('/')[0];
    if (slug) return { platform: 'twitch', kind: 'clip', mediaId: slug };
  }
  if (host === 'twitch.tv') {
    const vm = u.pathname.match(/^\/videos\/(\d+)/);
    if (vm) return { platform: 'twitch', kind: 'video', mediaId: vm[1] };
    const cm = u.pathname.match(/^\/[\w]+\/clip\/([\w-]+)/);
    if (cm) return { platform: 'twitch', kind: 'clip', mediaId: cm[1] };
  }
  return null;
}

// ---------- Users ----------

/** The picture people chose on Create & Connect, or their Discord one. */
export const avatarOf = (u) => u.customAvatar || u.avatar;

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    discordUsername: u.discordUsername,
    displayName: u.displayName || u.discordGlobalName || u.discordUsername,
    avatar: avatarOf(u),
    discordAvatar: u.avatar,
    pronouns: u.pronouns || '',
    banner: u.banner || 'violet',
    bio: u.bio || '',
    lookingFor: u.lookingFor || '',
    platforms: u.platforms || {},
    categories: u.categories || [],
    discordVerified: true,
    createdAt: u.createdAt,
    friendCount: (u.friendIds || []).length,
  };
}

export function miniUser(u) {
  if (!u) return null;
  return { id: u.id, displayName: u.displayName || u.discordUsername, discordUsername: u.discordUsername, avatar: avatarOf(u) };
}

// ---------- Lobby rules ----------

export const isManager = (lobby, uid) => !!uid && (lobby.hostId === uid || lobby.coHostIds.includes(uid));
export const isMember = (lobby, uid) => !!uid && lobby.memberIds.includes(uid);
export const isWaitlisted = (lobby, uid) => !!uid && (lobby.waitlist || []).includes(uid);
export const hasVoted = (lobby, uid) => !!uid && !!lobby.poll?.votes?.[uid];

/** host = the lobby host's user record (needed for the "friends" visibility). */
export function canView(lobby, uid, host) {
  if (lobby.status === 'cancelled') return isManager(lobby, uid);
  if (isManager(lobby, uid) || isMember(lobby, uid) || isWaitlisted(lobby, uid) || hasVoted(lobby, uid) || (uid && lobby.requestIds.includes(uid))) return true;
  switch (lobby.visibility) {
    case 'public':
    case 'code':
      return true;
    case 'private':
      return !!uid && lobby.invitedIds.includes(uid);
    case 'friends':
      return !!uid && (host?.friendIds || []).includes(uid);
    default:
      return false;
  }
}

// ---------- Repeating lobbies ----------
// A repeating lobby stores its first date (scheduledAt), a rule like
// { unit: 'week', every: 2 }, the host's time zone, and an optional last date.
// Each date ("session") gets its own sign-up list and its own Discord channels.

export const REPEATS = {
  daily: { unit: 'day', every: 1 },
  weekly: { unit: 'week', every: 1 },
  biweekly: { unit: 'week', every: 2 },
  '3weeks': { unit: 'week', every: 3 },
  '4weeks': { unit: 'week', every: 4 },
  monthly: { unit: 'month', every: 1 },
};
export const repeatKey = (r) => r ? Object.keys(REPEATS).find((k) => REPEATS[k].unit === r.unit && REPEATS[k].every === r.every) || null : null;

/** Times are picked in 5-minute steps (like Google Calendar); anything else is rounded to the nearest 5. */
export const snapTo5Min = (iso) => {
  const ms = Date.parse(iso);
  return isNaN(ms) ? null : new Date(Math.round(ms / 300e3) * 300e3).toISOString();
};

/** How long each date lasts, from the optional end time of the first date. 0 = no end time set. */
export const lobbyDuration = (l) => (l.scheduledAt && l.endsAt ? Math.max(0, Date.parse(l.endsAt) - Date.parse(l.scheduledAt)) : 0);
export const endOf = (l, startIso) => {
  const d = lobbyDuration(l);
  return d && startIso ? new Date(Date.parse(startIso) + d).toISOString() : null;
};

// How many future dates are open for sign-up at once: the host picks 1-9, default 6.
export const DEFAULT_AHEAD = 6;
export const MAX_AHEAD = 9;
export const aheadOf = (l) => Math.max(1, Math.min(MAX_AHEAD, parseInt(l.recurrence?.ahead, 10) || DEFAULT_AHEAD));
const UPCOMING = DEFAULT_AHEAD;
const SESSION_LENGTH_MS = 12 * 3600e3; // a date counts as over 12h after it starts
export const isPast = (s, nowMs = Date.now()) => Date.parse(s.at) + SESSION_LENGTH_MS < nowMs;

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz ? tz : 'UTC'; } catch { return 'UTC'; }
}

function zoneParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

/** Wall-clock time in a time zone -> UTC ms (handles daylight saving). */
function zonedToUtc(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, tz);
    const diff = want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

const pad = (n) => String(n).padStart(2, '0');

/** The n-th date of the series, in the host's time zone (same local time every time). */
function occurrence(start, rule, tz, n) {
  let y = start.y, mo = start.mo, d = start.d;
  if (rule.unit === 'month') {
    const total = (mo - 1) + n * rule.every;
    y = start.y + Math.floor(total / 12);
    mo = (total % 12) + 1;
    d = Math.min(start.d, new Date(Date.UTC(y, mo, 0)).getUTCDate()); // e.g. the 31st -> 30th
  } else {
    const t = new Date(Date.UTC(y, mo - 1, d + n * rule.every * (rule.unit === 'week' ? 7 : 1)));
    y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate();
  }
  return { key: `${y}-${pad(mo)}-${pad(d)}`, at: new Date(zonedToUtc(y, mo, d, start.h, start.mi, tz)).toISOString() };
}

/** The next few dates that haven't happened yet. */
export function upcomingDates(l, nowMs = Date.now(), count = UPCOMING) {
  const r = l.recurrence;
  if (!r || !l.scheduledAt) return [];
  const start = zoneParts(Date.parse(l.scheduledAt), r.timeZone);
  const out = [];
  for (let n = 0; n < 5000 && out.length < count; n++) {
    const o = occurrence(start, r, r.timeZone, n);
    if (r.until && o.key > r.until) break;
    if (!isPast(o, nowMs)) out.push(o);
  }
  return out;
}

/** "YYYY-MM-DD" of a moment in the series' time zone. */
export const dateKey = (iso, tz) => { const p = zoneParts(Date.parse(iso), tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };

/**
 * Bring l.sessions in line with the schedule: add the next dates, move times if the
 * host changed them, and drop future dates that are no longer on the schedule.
 * Returns the dropped sessions so their Discord channels can be deleted.
 */
export function syncSessionSchedule(l, nowMs = Date.now()) {
  if (!l.recurrence || l.status !== 'open') return [];
  // Dates up to the max count still belong to the schedule (so lowering the count
  // doesn't wipe dates people signed up for), but new ones only open inside the window.
  const onSchedule = new Map(upcomingDates(l, nowMs, MAX_AHEAD).map((o) => [o.key, o]));
  const windowKeys = new Set([...onSchedule.keys()].slice(0, aheadOf(l)));
  const byKey = new Map([...onSchedule].filter(([k]) => windowKeys.has(k)));
  const removed = [];
  const kept = [];
  for (const s of l.sessions || []) {
    if (isPast(s, nowMs)) {
      // keep recent past dates (their channels live 14 more days); forget old ones
      const old = Date.parse(s.at) < nowMs - 30 * 864e5;
      if (!old || (s.discord?.textId && !s.discord.deletedAt)) kept.push(s);
      continue;
    }
    const o = onSchedule.get(s.key);
    if (!o) { removed.push(s); continue; }
    // Outside the window and nobody but the host signed up: close it again.
    const onlyHost = s.memberIds.every((id) => id === l.hostId) && !s.discord?.textId;
    if (!windowKeys.has(s.key) && onlyHost) { removed.push(s); continue; }
    s.at = o.at;
    byKey.delete(s.key);
    kept.push(s);
  }
  for (const o of byKey.values()) kept.push({ key: o.key, at: o.at, memberIds: [l.hostId], discord: {} });
  kept.sort((a, b) => a.at.localeCompare(b.at));
  l.sessions = kept;
  return removed;
}

export const nextSession = (l, nowMs = Date.now()) =>
  (l.sessions || []).find((s) => !isPast(s, nowMs) && s.status !== 'skipped') || null;

// ---------- Join questions ----------
// A host can ask people questions when they join (any lobby type). Answers are
// only shown to the host and co-hosts, and help them decide on approval.

export const QUESTION_TYPES = ['short', 'long', 'choice', 'multi'];
export const MAX_QUESTIONS = 10;
const ANSWER_LIMIT = { short: 200, long: 1000 };

/** Clean the host's question list. Keeps the ids of existing questions so earlier answers still line up. */
export function cleanQuestions(raw, existing = []) {
  if (!Array.isArray(raw)) return existing;
  const known = new Set(existing.map((q) => q.id));
  const out = [];
  for (const q of raw.slice(0, MAX_QUESTIONS)) {
    const label = String(q?.label ?? '').trim().slice(0, 200);
    if (!label) continue;
    const type = QUESTION_TYPES.includes(q.type) ? q.type : 'short';
    const options = ['choice', 'multi'].includes(type)
      ? [...new Set((Array.isArray(q.options) ? q.options : []).map((o) => String(o ?? '').trim().slice(0, 80)).filter(Boolean))].slice(0, 12)
      : [];
    if (options.length < 2 && ['choice', 'multi'].includes(type)) throw new HttpError(400, `"${label}" needs at least 2 options`);
    const id = typeof q.id === 'string' && known.has(q.id) ? q.id : newId();
    out.push({ id, label, type, options, required: q.required === true });
  }
  return out;
}

/** Check someone's answers against the questions. Returns { questionId: answer }. */
export function checkAnswers(questions, raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const q of questions || []) {
    let v = given[q.id];
    if (q.type === 'multi') {
      v = [...new Set((Array.isArray(v) ? v : []).map(String))].filter((o) => q.options.includes(o));
      if (!v.length) v = null;
    } else if (q.type === 'choice') {
      v = q.options.includes(String(v ?? '')) ? String(v) : null;
    } else {
      v = String(v ?? '').trim();
      if (v.length > ANSWER_LIMIT[q.type]) throw new HttpError(400, `Your answer to "${q.label}" is too long`);
      if (!v) v = null;
    }
    if (v === null) {
      if (q.required) throw new HttpError(400, `Please answer "${q.label}"`, 'ANSWERS_NEEDED');
      continue;
    }
    out[q.id] = v;
  }
  return out;
}

// ---------- Waitlist ----------
// Every lobby has one. When a lobby (or a date of a repeating lobby) is full, people
// who'd otherwise get in join the waitlist, and the earliest one gets the next free spot.

/** Move people off the waitlist into free spots. Returns who got in. */
export function fillFromWaitlist(l, nowMs = Date.now()) {
  const promoted = [];
  if (l.status !== 'open') return promoted;
  if (l.recurrence) {
    for (const s of l.sessions || []) {
      s.waitlist ||= [];
      if (isPast(s, nowMs) || s.status === 'skipped') continue;
      while (s.memberIds.length < l.maxSlots && s.waitlist.length) {
        const uid = s.waitlist.shift();
        if (!s.memberIds.includes(uid)) { s.memberIds.push(uid); promoted.push(uid); }
      }
    }
    return promoted;
  }
  l.waitlist ||= [];
  while (l.memberIds.length < l.maxSlots && l.waitlist.length) {
    const uid = l.waitlist.shift();
    if (l.memberIds.includes(uid)) continue;
    l.memberIds.push(uid);
    l.requestIds = l.requestIds.filter((x) => x !== uid);
    l.invitedIds = l.invitedIds.filter((x) => x !== uid);
    promoted.push(uid);
  }
  return promoted;
}

// ---------- Date poll ----------
// Instead of a start time, a host can offer a few dates (each with an optional time)
// and let people say Yes / Maybe / No to each when they join or ask to join.
// The date is picked by the host, or automatically once enough people answered or
// on a set date: the one with the most Yes (then most Maybe, then the earliest).
// Yes-voters fill the spots in the order they answered, then Maybes fill any spots
// left; everyone else who said Yes or Maybe goes on the waitlist in that order.

export const POLL_DECIDE = ['manual', 'responses', 'deadline'];
export const POLL_CHOICES = ['yes', 'maybe', 'no'];
export const MAX_POLL_OPTIONS = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Clean the host's poll. Keeps option ids (and the votes for them) when the host edits it. */
export function cleanPoll(raw, existing, maxSlots, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') fail(400, 'Add the dates for the poll');
  const known = new Set((existing?.options || []).map((o) => o.id));
  const seen = new Set();
  const options = [];
  for (const o of (Array.isArray(raw.options) ? raw.options : []).slice(0, MAX_POLL_OPTIONS * 2)) {
    const date = String(o?.date || '');
    if (!DATE_RE.test(date)) continue;
    const start = o.start ? snapTo5Min(o.start) : null;
    const end = start && o.end ? snapTo5Min(o.end) : null;
    if (end && end <= start) fail(400, 'Each poll option has to end after it starts');
    if (end && Date.parse(end) - Date.parse(start) > 30 * 864e5) fail(400, 'A lobby can last at most 30 days');
    const k = `${date}|${start || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    options.push({ id: typeof o.id === 'string' && known.has(o.id) ? o.id : newId().slice(0, 8), date, start, end });
  }
  if (options.length > MAX_POLL_OPTIONS) fail(400, `A poll can have at most ${MAX_POLL_OPTIONS} options`);
  if (new Set(options.map((o) => o.date)).size < 2) fail(400, 'A date poll needs at least 2 different dates');
  options.sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  const decide = POLL_DECIDE.includes(raw.decide) ? raw.decide : 'manual';
  const target = Math.max(1, Math.min(100, parseInt(raw.target, 10) || Math.max(1, (maxSlots || 2) - 1)));
  let closesAt = null;
  if (decide === 'deadline') {
    closesAt = raw.closesAt ? snapTo5Min(raw.closesAt) : null;
    if (!closesAt) fail(400, 'Pick when the poll closes');
    if (closesAt !== existing?.closesAt && Date.parse(closesAt) <= nowMs) fail(400, 'The poll has to close in the future');
  }
  // Votes for options that were removed are dropped; everyone keeps their place in line.
  const ids = new Set(options.map((o) => o.id));
  const votes = {};
  for (const [uid, v] of Object.entries(existing?.votes || {})) {
    votes[uid] = { at: v.at, picks: Object.fromEntries(Object.entries(v.picks).filter(([id]) => ids.has(id))) };
  }
  return { options, decide, target, closesAt, votes, decidedId: null };
}

/** Someone's Yes / Maybe / No for every option. */
export function checkVote(poll, raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const picks = {};
  for (const o of poll.options) {
    const v = given[o.id];
    if (!POLL_CHOICES.includes(v)) fail(400, 'Say Yes, Maybe or No for every date', 'VOTE_NEEDED');
    picks[o.id] = v;
  }
  if (!Object.values(picks).some((v) => v !== 'no')) fail(400, "Say Yes or Maybe to at least one date. If none work, you don't need to join.");
  return picks;
}

/** Votes that count: everyone who answered, minus people still waiting for approval. Earliest first. */
export const countedVotes = (l) => Object.entries(l.poll?.votes || {})
  .filter(([uid]) => !l.requestIds.includes(uid))
  .map(([uid, v]) => ({ uid, ...v }))
  .sort((a, b) => a.at.localeCompare(b.at));

export function pollTally(l) {
  const votes = countedVotes(l);
  return l.poll.options.map((o) => {
    const t = { ...o, yes: 0, maybe: 0, no: 0 };
    for (const v of votes) if (v.picks[o.id]) t[v.picks[o.id]]++;
    return t;
  });
}

/** The option with the most Yes (then Maybe, then earliest). Null if nobody said Yes to anything. */
export function pollWinner(l) {
  const ranked = pollTally(l).sort((a, b) => b.yes - a.yes || b.maybe - a.maybe);
  return ranked[0]?.yes ? ranked[0] : null;
}

/** Whether the poll should pick its date now. */
export function pollDue(l, nowMs = Date.now()) {
  const p = l.poll;
  if (!p || p.decidedId || l.status !== 'open') return false;
  if (p.decide === 'responses') return countedVotes(l).length >= p.target;
  if (p.decide === 'deadline') return !!p.closesAt && Date.parse(p.closesAt) <= nowMs;
  return false;
}

/**
 * Set the lobby's date to one poll option and seat people: Yes-voters in the order
 * they answered, then Maybes, until the spots run out; the rest go on the waitlist.
 * by = the host's id, or 'auto'.
 */
export function decidePoll(l, optionId, by) {
  const p = l.poll;
  const o = p.options.find((x) => x.id === optionId);
  if (!o) fail(404, 'That date is not in the poll');
  p.decidedId = o.id;
  p.decidedAt = now();
  p.decidedBy = by;
  l.scheduledAt = o.start || null;
  l.endsAt = o.end || null;
  l.day = o.start ? null : o.date;
  const votes = countedVotes(l);
  const seat = (uid) => {
    if (l.memberIds.includes(uid) || l.waitlist.includes(uid)) return;
    if (l.memberIds.length < l.maxSlots) l.memberIds.push(uid);
    else l.waitlist.push(uid);
  };
  const result = { added: [], waitlisted: [], dropped: [] };
  for (const v of votes) if (v.picks[o.id] === 'yes') seat(v.uid);
  for (const v of votes) if (v.picks[o.id] === 'maybe') seat(v.uid); // Maybes only get spots no Yes needed
  for (const v of votes) {
    if (l.memberIds.includes(v.uid)) result.added.push(v.uid);
    else if (l.waitlist.includes(v.uid)) result.waitlisted.push(v.uid);
    else result.dropped.push(v.uid);
  }
  for (const uid of result.dropped) delete l.answers?.[uid];
  return result;
}

/** A poll option as text, e.g. "Fri, Dec 4, 7:00 PM" (times in the given zone). */
export function pollOptionText(o, timeZone = 'UTC') {
  const [y, m, d] = o.date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  if (!o.start) return day;
  return `${day}, ${new Date(o.start).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
}
