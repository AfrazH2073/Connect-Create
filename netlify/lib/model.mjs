// Shared constants, validation and visibility rules.
import crypto from 'node:crypto';

export const PLATFORMS = ['youtube', 'twitch'];
export const CATEGORIES = [
  'Gaming', 'IRL', 'Just Chatting', 'STEM', 'Tech', 'Education', 'Beauty', 'Fashion',
  'Music', 'Art', 'Comedy', 'Fitness', 'Cooking', 'Travel', 'ASMR', 'Podcasts',
  'Sports', 'Esports', 'Speedrunning', 'Horror', 'Vlogs', 'Reviews',
];
export const VISIBILITIES = ['public', 'approval', 'code', 'private', 'friends'];

export const newId = () => crypto.randomBytes(9).toString('base64url');
export const newCode = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
export const now = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

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

/** Accept "@handle", "handle", or a full channel URL and return a clean handle. */
export function cleanHandle(platform, input) {
  let s = str(input, 200);
  if (!s) return '';
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const parts = u.pathname.split('/').filter(Boolean);
      if (platform === 'youtube') {
        const at = parts.find((p) => p.startsWith('@'));
        s = at || (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user' ? parts.slice(0, 2).join('/') : parts[0] || '');
      } else {
        s = parts[0] || '';
      }
    }
  } catch { /* fall through */ }
  s = s.replace(/^@/, '');
  return s.replace(/[^\w.\-/]/g, '').slice(0, 100);
}

export function platformUrl(platform, handle) {
  if (!handle) return '';
  if (platform === 'youtube') return handle.includes('/') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/@${handle}`;
  if (platform === 'twitch') return `https://www.twitch.tv/${handle}`;
  return '';
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

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    discordUsername: u.discordUsername,
    displayName: u.displayName || u.discordGlobalName || u.discordUsername,
    avatar: u.avatar,
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
  return { id: u.id, displayName: u.displayName || u.discordUsername, discordUsername: u.discordUsername, avatar: u.avatar };
}

// ---------- Lobby rules ----------

export const isManager = (lobby, uid) => !!uid && (lobby.hostId === uid || lobby.coHostIds.includes(uid));
export const isMember = (lobby, uid) => !!uid && lobby.memberIds.includes(uid);

/** host = the lobby host's user record (needed for the "friends" visibility). */
export function canView(lobby, uid, host) {
  if (lobby.status === 'cancelled') return isManager(lobby, uid);
  if (isManager(lobby, uid) || isMember(lobby, uid) || (uid && lobby.requestIds.includes(uid))) return true;
  switch (lobby.visibility) {
    case 'public':
    case 'approval':
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
