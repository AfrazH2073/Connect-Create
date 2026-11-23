// Discord integration — 100% free: an OAuth2 app (for login / verifying the
// user's real Discord account) plus a bot user that only uses Discord's REST
// API (no always-on gateway process needed, so it runs fine on Netlify).

import { isPast } from './model.mjs';

const API = 'https://discord.com/api/v10';

// Permission bits (https://discord.com/developers/docs/topics/permissions)
const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADD_REACTIONS: 1n << 6n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  USE_VAD: 1n << 25n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 28n,
};

const MEMBER_ALLOW = String(
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.EMBED_LINKS | P.ATTACH_FILES |
  P.ADD_REACTIONS | P.CONNECT | P.SPEAK | P.USE_VAD | P.STREAM
);
const BOT_ALLOW = String(BigInt(MEMBER_ALLOW) | P.MANAGE_CHANNELS | P.MANAGE_ROLES);

export const discordConfigured = () =>
  Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);

async function bot(method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
        // Discord requires bot User-Agents in exactly this "DiscordBot (url, version)" form.
        'User-Agent': 'DiscordBot (https://createconnect.netlify.app, 1.0)',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.min(5000, (data.retry_after || 1) * 1000)));
      continue;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`Discord ${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
      err.status = res.status;
      err.code = data?.code;
      err.data = data;
      throw err;
    }
    return data;
  }
  throw new Error(`Discord ${method} ${path} rate limited`);
}

/** Turn a Discord API error into a setup hint a host can act on. */
export function explainDiscordError(e) {
  const raw = JSON.stringify(e.data || {});
  if (e.status === 401) return 'Discord rejected the bot token. Copy a fresh token (Developer Portal → Bot → Reset Token), update DISCORD_BOT_TOKEN in Netlify, and redeploy.';
  if (e.code === 10004 || (e.status === 404 && /guild/i.test(raw))) return 'Discord says that server doesn\'t exist for this bot. Check DISCORD_GUILD_ID in Netlify and that the bot was added to the Create and Connect server.';
  if (e.code === 50001) return 'The bot is missing access. Make sure it is in the Create and Connect server (invite it via Developer Portal → OAuth2 → URL Generator → "bot" + Administrator).';
  if (e.code === 50013) return 'The bot is missing permissions. First check the bot is actually in the Create and Connect server (invite it via Developer Portal → OAuth2 → URL Generator → "bot" + Administrator). If it is, go to Server Settings → Roles → the bot\'s role → turn on Administrator.';
  if (e.code === 30013 || /maximum number of (guild )?channels/i.test(raw)) return 'The Discord server hit its 500-channel limit. Delete some old channels or categories in Discord, then retry.';
  if (e.status === 403 && !e.code) return 'Discord blocked the request (HTTP 403). This is usually temporary — try again in a minute.';
  return `Discord error ${e.status || ''}${e.code ? ` (code ${e.code})` : ''}: ${e.data?.message || e.message}`.trim();
}

// ---------- OAuth (login + verification) ----------

// prompt 'consent' always shows Discord's approval screen, which has a
// "Not you?" link for signing in with a different Discord account.
export function authorizeUrl(redirectUri, state, prompt = 'none') {
  const p = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    // identify = read your verified username/ID; guilds.join = auto-add you to the Create and Connect server
    scope: 'identify guilds.join',
    state,
    prompt,
  });
  return `https://discord.com/oauth2/authorize?${p}`;
}

export async function exchangeCode(code, redirectUri) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function fetchDiscordUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Discord /users/@me failed: ${res.status}`);
  return res.json();
}

/**
 * Is this Discord user in the Create and Connect server?
 * Returns true/false, or null if we can't tell (bot not set up, Discord down) — callers
 * should not block anyone on null.
 */
export async function isGuildMember(userId) {
  if (!discordConfigured()) return null;
  try {
    await bot('GET', `/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`);
    return true;
  } catch (e) {
    if (e.code === 10007 || e.code === 10013) return false; // Unknown Member / Unknown User
    console.error('isGuildMember check failed', e.message);
    return null;
  }
}

/** Adds the user to the Create and Connect server (no-op if already a member). */
export async function addToGuild(userId, accessToken) {
  if (!discordConfigured()) return false;
  try {
    await bot('PUT', `/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`, { access_token: accessToken });
    return true;
  } catch (e) {
    console.error('addToGuild failed', e.message);
    return false;
  }
}

// ---------- Lobby channels ----------
// Every lobby gets its own Discord category. A one-time lobby has one text + voice
// channel in it. A repeating lobby gets a text + voice channel per date, named
// with the date first (e.g. "2026-12-07-smash-bros").

function channelSlug(title) {
  const s = String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'lobby').slice(0, 80);
}

async function setMember(channelId, userId) {
  await bot('PUT', `/channels/${channelId}/permissions/${userId}`, { type: 1, allow: MEMBER_ALLOW, deny: '0' });
}

async function removeMember(channelId, userId) {
  try {
    await bot('DELETE', `/channels/${channelId}/permissions/${userId}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

async function deleteChannel(id) {
  if (!id) return;
  try {
    await bot('DELETE', `/channels/${id}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

const hidden = () => [
  { id: process.env.DISCORD_GUILD_ID, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) }, // hide from @everyone
  { id: process.env.DISCORD_CLIENT_ID, type: 1, allow: BOT_ALLOW, deny: '0' }, // keep bot access
];

/** Give `want` access to the channels and take it from anyone else we added before. */
async function syncAccess(channelIds, want, haveList) {
  const have = new Set(haveList || []);
  const failed = [];
  for (const uid of want) {
    if (have.has(uid)) continue;
    try {
      for (const id of channelIds) await setMember(id, uid);
      have.add(uid);
    } catch (e) {
      console.error('Could not grant channel access to', uid, e.message);
      failed.push(uid);
    }
  }
  for (const uid of [...have]) {
    if (want.includes(uid)) continue;
    for (const id of channelIds) await removeMember(id, uid);
    have.delete(uid);
  }
  return { have: [...have], failed };
}

async function ensureCategory(lobby, d) {
  if (!d.categoryId) {
    const cat = await bot('POST', `/guilds/${process.env.DISCORD_GUILD_ID}/channels`, {
      name: String(lobby.title).slice(0, 100), type: 4, permission_overwrites: hidden(),
    });
    d.categoryId = cat.id;
    d.categoryMemberIds = [];
  }
  // Members can see the category header too (their own channels inside are what matter).
  const { have } = await syncAccess([d.categoryId], lobby.memberIds, d.categoryMemberIds);
  d.categoryMemberIds = have;
  return d.categoryId;
}

/**
 * Channels made before each lobby had its own category (e.g. under a shared "Lobbies"
 * category): create the lobby's category and move them into it. If someone deleted a
 * channel by hand in Discord, forget it so it gets made again.
 */
export async function moveIntoOwnCategory(lobby) {
  const d = lobby.discord;
  if (!d || d.deletedAt || !discordConfigured()) return false;
  const rooms = lobby.recurrence ? (lobby.sessions || []).map((s) => s.discord).filter(Boolean) : [d];
  const ids = (room) => ['textId', 'voiceId'].filter((k) => room[k] && !room.deletedAt);
  const stray = rooms.filter((room) => ids(room).length && (!d.categoryId || room.parentId !== d.categoryId));
  if (!stray.length) return false;
  const parentId = await ensureCategory(lobby, d);
  for (const room of stray) {
    for (const k of ids(room)) {
      try {
        // lock_permissions false keeps the members-only access on the channel.
        await bot('PATCH', `/channels/${room[k]}`, { parent_id: parentId, lock_permissions: false });
      } catch (e) {
        if (e.status !== 404) throw e;
        room[k] = null; // gone from Discord; syncRoom will recreate it
        room.memberIds = [];
      }
    }
    room.parentId = parentId;
  }
  return true;
}

/** Create (once) and sync one text + voice pair. `room` is where the IDs are saved. */
async function syncRoom(room, { name, voiceName, topic, parentId, memberIds, welcome }) {
  const guild = process.env.DISCORD_GUILD_ID;
  const base = { parent_id: parentId || undefined, permission_overwrites: hidden() };
  // Each ID is saved as soon as it exists, so a failure halfway never leaves an orphan channel.
  room.parentId = parentId || null;
  if (!room.textId) {
    const text = await bot('POST', `/guilds/${guild}/channels`, { ...base, name, type: 0, topic: topic.slice(0, 1024) });
    room.textId = text.id;
    room.memberIds = [];
    room.createdAt = new Date().toISOString();
  }
  if (!room.voiceId) {
    const voice = await bot('POST', `/guilds/${guild}/channels`, { ...base, name: voiceName.slice(0, 100), type: 2 });
    room.voiceId = voice.id;
    room.memberIds = []; // re-apply member access to both channels
  }
  const before = room.memberIds || [];
  const { have, failed } = await syncAccess([room.textId, room.voiceId], memberIds, before);
  const newlyAdded = have.filter((u) => !before.includes(u));
  room.memberIds = have;
  room.failedIds = failed;
  if (newlyAdded.length) {
    await bot('POST', `/channels/${room.textId}/messages`, {
      content: welcome(newlyAdded.map((u) => `<@${u}>`).join(' ')),
      allowed_mentions: { users: newlyAdded },
    }).catch((e) => console.error('welcome message failed', e.message));
  }
}

export function sessionLabel(lobby, s) {
  return new Date(s.at).toLocaleString('en-US', {
    timeZone: lobby.recurrence?.timeZone || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

/** Dates of a repeating lobby that should have channels right now. */
const activeSessions = (lobby, nowMs = Date.now()) => (lobby.sessions || []).filter((s) =>
  s.status !== 'skipped' && !isPast(s, nowMs) && !s.discord?.deletedAt && (s.discord?.textId || s.memberIds.length >= 2));

/**
 * Make the lobby's private Discord channels match its member / sign-up lists.
 * Channels open once 2+ people are in (per date for repeating lobbies).
 * Mutates and returns lobby.discord.
 */
export async function syncLobbyChannels(lobby, siteUrl) {
  lobby.discord ||= {};
  const d = lobby.discord;
  if (d.deletedAt || lobby.status === 'cancelled') return d;
  const missing = ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_CLIENT_ID'].filter((k) => !process.env[k]);
  if (missing.length) {
    d.error = `The site can't see ${missing.join(' and ')} in Netlify. Add it under Site configuration → Environment variables (scope must include Functions), then redeploy.`;
    console.error('syncLobbyChannels skipped:', d.error);
    return d;
  }
  const page = `${siteUrl}/#/lobbies/${lobby.id}`;
  const slug = channelSlug(lobby.title);
  try {
    if (lobby.recurrence) {
      const sessions = activeSessions(lobby);
      if (!sessions.length && !d.categoryId) { d.error = null; return d; }
      const parentId = await ensureCategory(lobby, d);
      await moveIntoOwnCategory(lobby);
      const failed = new Set();
      for (const s of sessions) {
        s.discord ||= {};
        const when = sessionLabel(lobby, s);
        await syncRoom(s.discord, {
          name: `${s.key}-${slug}`.slice(0, 100),
          voiceName: `🔊 ${s.key} ${lobby.title}`,
          topic: `Create & Connect: ${lobby.title} on ${when} — ${page}`,
          parentId,
          memberIds: s.memberIds,
          welcome: (mentions) => `👋 Welcome ${mentions} to **${lobby.title}** on **${when}**! This chat and the voice channel are private to people signed up for this date.\nLobby page: ${page}`,
        });
        for (const u of s.discord.failedIds || []) failed.add(u);
      }
      d.failedIds = [...failed];
    } else {
      if (!d.textId && lobby.memberIds.length < 2) {
        d.error = null; // nothing to do yet; channels open once a 2nd person joins
        return d;
      }
      const parentId = await ensureCategory(lobby, d);
      await moveIntoOwnCategory(lobby); // older channels sitting in another category
      await syncRoom(d, {
        name: slug,
        voiceName: `🔊 ${lobby.title}`,
        topic: `Create & Connect lobby: ${lobby.title} — ${page}`,
        parentId,
        memberIds: lobby.memberIds,
        welcome: (mentions) => `👋 Welcome ${mentions} to **${lobby.title}**! This chat and the voice channel are private to lobby members.\nLobby page: ${page}`,
      });
    }
    d.error = null;
  } catch (e) {
    console.error('syncLobbyChannels failed', e.message);
    d.error = explainDiscordError(e);
  }
  return d;
}

export async function postToLobby(lobby, content) {
  const d = lobby.discord;
  if (!discordConfigured() || !d || d.deletedAt) return;
  const ids = [d.textId, ...activeSessions(lobby).map((s) => s.discord?.textId)].filter(Boolean);
  for (const id of ids) {
    await bot('POST', `/channels/${id}/messages`, { content, allowed_mentions: { parse: [] } })
      .catch((e) => console.error('postToLobby failed', e.message));
  }
}

/** Delete one date's (or a one-time lobby's) text + voice channels. */
export async function deleteRoom(room) {
  if (!room || room.deletedAt || !room.textId && !room.voiceId) return;
  if (!discordConfigured()) return;
  await deleteChannel(room.textId);
  await deleteChannel(room.voiceId);
  room.deletedAt = new Date().toISOString();
}

export const hasChannels = (lobby) => {
  const d = lobby.discord;
  if (!d || d.deletedAt) return false;
  return !!(d.textId || d.categoryId || (lobby.sessions || []).some((s) => s.discord?.textId && !s.discord.deletedAt));
};

/** Delete everything: every date's channels, the main channels, and the category. */
export async function deleteLobbyChannels(lobby) {
  const d = lobby.discord;
  if (!d || d.deletedAt || !discordConfigured()) return;
  for (const s of lobby.sessions || []) await deleteRoom(s.discord);
  await deleteChannel(d.textId);
  await deleteChannel(d.voiceId);
  await deleteChannel(d.categoryId);
  d.deletedAt = new Date().toISOString();
}
