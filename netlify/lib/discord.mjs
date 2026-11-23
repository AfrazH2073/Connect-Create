// Discord integration — 100% free: an OAuth2 app (for login / verifying the
// user's real Discord account) plus a bot user that only uses Discord's REST
// API (no always-on gateway process needed, so it runs fine on Netlify).

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
  if (e.code === 50001) return 'The bot is missing access. Make sure it is in the Create and Connect server (invite it via Developer Portal → OAuth2 → URL Generator → "bot" + Administrator), and that it can see the lobby category if DISCORD_CATEGORY_ID is set.';
  if (e.code === 50013) return 'The bot is missing permissions. First check the bot is actually in the Create and Connect server (invite it via Developer Portal → OAuth2 → URL Generator → "bot" + Administrator). If it is, go to Server Settings → Roles → the bot\'s role → turn on Administrator.';
  if (e.status === 400 && /parent_id/.test(raw)) return 'DISCORD_CATEGORY_ID is not a category in this server. Fix it in Netlify (or delete it) and redeploy.';
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

/**
 * Make the lobby's private Discord text + voice channels match its member list.
 * Creates them once the lobby has 2+ members. Mutates and returns lobby.discord.
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
  const memberIds = lobby.memberIds;
  if (!d.textId && memberIds.length < 2) {
    d.error = null; // nothing to do yet; channels open once a 2nd person joins
    return d;
  }

  const guild = process.env.DISCORD_GUILD_ID;
  try {
    const base = {
      parent_id: process.env.DISCORD_CATEGORY_ID || undefined,
      permission_overwrites: [
        { id: guild, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) }, // hide from @everyone
        { id: process.env.DISCORD_CLIENT_ID, type: 1, allow: BOT_ALLOW, deny: '0' }, // keep bot access
      ],
    };
    // Each ID is saved as soon as it exists, so a failure halfway never leaves an orphan channel.
    if (!d.textId) {
      const text = await bot('POST', `/guilds/${guild}/channels`, {
        ...base,
        name: channelSlug(lobby.title),
        type: 0,
        topic: `Create & Connect lobby: ${lobby.title} — ${siteUrl}/#/lobbies/${lobby.id}`.slice(0, 1024),
      });
      d.textId = text.id;
      d.memberIds = [];
      d.createdAt = new Date().toISOString();
    }
    if (!d.voiceId) {
      const voice = await bot('POST', `/guilds/${guild}/channels`, { ...base, name: `🔊 ${lobby.title}`.slice(0, 100), type: 2 });
      d.voiceId = voice.id;
      d.memberIds = []; // re-apply member access to both channels
    }

    const want = new Set(memberIds);
    const have = new Set(d.memberIds || []);
    const failed = [];
    for (const uid of want) {
      if (have.has(uid)) continue;
      try {
        await setMember(d.textId, uid);
        await setMember(d.voiceId, uid);
        have.add(uid);
      } catch (e) {
        console.error('Could not grant channel access to', uid, e.message);
        failed.push(uid);
      }
    }
    for (const uid of [...have]) {
      if (want.has(uid)) continue;
      await removeMember(d.textId, uid);
      await removeMember(d.voiceId, uid);
      have.delete(uid);
    }
    const newlyAdded = [...have].filter((u) => !(d.memberIds || []).includes(u));
    d.memberIds = [...have];
    d.failedIds = failed;
    d.error = null;

    if (newlyAdded.length) {
      const mentions = newlyAdded.map((u) => `<@${u}>`).join(' ');
      await bot('POST', `/channels/${d.textId}/messages`, {
        content: `👋 Welcome ${mentions} to **${lobby.title}**! This chat and the voice channel are private to lobby members.\nLobby page: ${siteUrl}/#/lobbies/${lobby.id}`,
        allowed_mentions: { users: newlyAdded },
      }).catch((e) => console.error('welcome message failed', e.message));
    }
  } catch (e) {
    console.error('syncLobbyChannels failed', e.message);
    d.error = explainDiscordError(e);
  }
  return d;
}

export async function postToLobby(lobby, content) {
  if (!discordConfigured() || !lobby.discord?.textId || lobby.discord.deletedAt) return;
  await bot('POST', `/channels/${lobby.discord.textId}/messages`, { content, allowed_mentions: { parse: [] } })
    .catch((e) => console.error('postToLobby failed', e.message));
}

export async function deleteLobbyChannels(lobby) {
  const d = lobby.discord;
  if (!d || d.deletedAt || !discordConfigured()) return;
  for (const id of [d.textId, d.voiceId]) {
    if (!id) continue;
    try {
      await bot('DELETE', `/channels/${id}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  d.deletedAt = new Date().toISOString();
}
