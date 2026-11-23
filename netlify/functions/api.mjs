// The whole backend API lives in this one Netlify Function.
// netlify.toml rewrites /api/* -> this function.

import { db } from '../lib/db.mjs';
import { createSessionCookie, clearSessionCookie, readSession, parseCookies, readAccounts, accountsCookie } from '../lib/session.mjs';
import * as discord from '../lib/discord.mjs';
import { isAdmin, reportLobbyFlags } from '../lib/reports.mjs';
import {
  PLATFORMS, LOBBY_PLATFORMS, CATEGORIES, VISIBILITIES, BANNERS, REPEATS, HttpError, fail, str, pick, idList, cleanHandle, platformUrl,
  parseMedia, newId, newCode, now, publicUser, miniUser, isManager, isMember, canView,
  repeatKey, validTimeZone, dateKey, syncSessionSchedule, nextSession, isPast,
} from '../lib/model.mjs';

// ---------- helpers ----------

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const redirect = (location, cookies = []) => {
  const h = new Headers({ Location: location });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
};

const siteOrigin = (req) => process.env.SITE_URL?.replace(/\/$/, '') || new URL(req.url).origin;
const isSecure = (req) => new URL(req.url).protocol === 'https:';

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

async function requireUser(ctx) {
  if (!ctx.uid) fail(401, 'Please log in with Discord first');
  const u = await db.users.get(ctx.uid);
  if (!u) fail(401, 'Account not found — please log in again');
  return u;
}

async function usersById(ids) {
  const list = await Promise.all([...new Set(ids)].map((id) => db.users.get(id)));
  return Object.fromEntries(list.filter(Boolean).map((u) => [u.id, u]));
}

// ---------- auth ----------

async function login(req) {
  if (!process.env.DISCORD_CLIENT_ID) fail(500, 'DISCORD_CLIENT_ID is not configured');
  const state = newId();
  const params = new URL(req.url).searchParams;
  const addAccount = params.get('add') === '1';
  const url = discord.authorizeUrl(`${siteOrigin(req)}/api/auth/callback`, state, addAccount ? 'consent' : 'none');
  const sec = isSecure(req) ? '; Secure' : '';
  const cookies = [`cc_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${sec}`];
  // Optional page to land on afterwards, e.g. the lobby you were joining. Only in-site hash routes.
  const back = params.get('return') || '';
  if (/^#\/[\w\-/?=&.%]{0,200}$/.test(back)) cookies.push(`cc_return=${encodeURIComponent(back)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${sec}`);
  // Only add people to the Discord server when they clicked "Add me to the server".
  // (Discord DMs everyone an app adds, so we don't do it silently on every login.)
  if (params.get('join') === '1') cookies.push(`cc_join=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${sec}`);
  return redirect(url, cookies);
}

async function callback(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== parseCookies(req).cc_oauth_state) {
    return redirect('/#/?error=login_failed');
  }
  const origin = siteOrigin(req);
  let token, du;
  try {
    token = await discord.exchangeCode(code, `${origin}/api/auth/callback`);
    du = await discord.fetchDiscordUser(token.access_token);
  } catch (e) {
    console.error(e);
    return redirect('/#/?error=login_failed');
  }
  const wantsJoin = parseCookies(req).cc_join === '1';
  const inServer = wantsJoin
    ? await discord.addToGuild(du.id, token.access_token)
    : await discord.isGuildMember(du.id); // just check; null = couldn't tell

  let user = await db.users.get(du.id);
  const isNew = !user;
  user ||= {
    id: du.id, createdAt: now(), displayName: du.global_name || du.username, bio: '', lookingFor: '',
    platforms: {}, categories: [], friendIds: [], friendRequestsIn: [], friendRequestsOut: [], onboarded: false,
  };
  // Always refresh from Discord: this is what makes the Discord tag "verified".
  user.discordUsername = du.username;
  user.discordGlobalName = du.global_name || '';
  user.avatar = du.avatar
    ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(du.id) >> 22n) % 6n)}.png`;
  user.inServer = inServer;
  user.lastLoginAt = now();
  await db.users.put(user);

  const back = parseCookies(req).cc_return;
  const target = isNew || !user.onboarded ? '/#/me/edit?welcome=1'
    : back && /^#\/[\w\-/?=&.%]{0,200}$/.test(back) ? `/${back}${back.includes('?') ? '&' : '?'}joined_server=${inServer ? 1 : 0}`
    : '/#/';
  return redirect(target, [
    createSessionCookie(user.id, isSecure(req)),
    accountsCookie([user.id, ...readAccounts(req)], isSecure(req)),
    'cc_oauth_state=; Path=/; Max-Age=0',
    'cc_return=; Path=/; Max-Age=0',
    'cc_join=; Path=/; Max-Age=0',
  ]);
}

// ---------- multiple accounts on one browser ----------

function withCookies(data, cookies) {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const c of cookies) h.append('Set-Cookie', c);
  return new Response(JSON.stringify(data), { status: 200, headers: h });
}

// Includes the current session even if it was created before accounts were remembered.
const knownAccounts = (req, ctx) => [...new Set([ctx.uid, ...readAccounts(req)].filter(Boolean))];

async function listAccounts(req, ctx) {
  const ids = knownAccounts(req, ctx);
  const users = await usersById(ids);
  return json({
    currentId: ctx.uid,
    accounts: ids.map((id) => miniUser(users[id])).filter(Boolean),
  });
}

async function switchAccount(req, ctx, b) {
  const ids = knownAccounts(req, ctx);
  if (!ids.includes(b.id)) fail(403, 'That account is not signed in on this browser — use "Add another account"');
  if (!(await db.users.get(b.id))) fail(404, 'Account not found');
  return withCookies({ ok: true }, [
    createSessionCookie(b.id, isSecure(req)),
    accountsCookie([b.id, ...ids], isSecure(req)),
  ]);
}

/** Logs out the current account. Switches to another remembered account if there is one, unless `all` is set. */
function logout(req, ctx, b) {
  const secure = isSecure(req);
  const rest = b.all ? [] : readAccounts(req).filter((id) => id !== ctx.uid);
  if (rest.length) {
    return withCookies({ ok: true, switchedTo: rest[0] }, [createSessionCookie(rest[0], secure), accountsCookie(rest, secure)]);
  }
  return withCookies({ ok: true, switchedTo: null }, [clearSessionCookie(), accountsCookie([], secure)]);
}

// ---------- me / users ----------

async function getMe(ctx) {
  if (!ctx.uid) return json({ user: null, config: clientConfig() });
  const u = await db.users.get(ctx.uid);
  if (!u) return json({ user: null, config: clientConfig() });
  return json({
    user: { ...publicUser(u), hasCustomAvatar: !!u.customAvatar, showHistory: !!u.showHistory, isAdmin: isAdmin(u.id), onboarded: !!u.onboarded, inServer: u.inServer, friendIds: u.friendIds, friendRequestsIn: u.friendRequestsIn, friendRequestsOut: u.friendRequestsOut },
    config: clientConfig(),
  });
}

function clientConfig() {
  return {
    categories: CATEGORIES, platforms: PLATFORMS, lobbyPlatforms: LOBBY_PLATFORMS, visibilities: VISIBILITIES, banners: BANNERS, repeats: Object.keys(REPEATS),
    discordGuildId: process.env.DISCORD_GUILD_ID || null,
    discordInvite: process.env.DISCORD_INVITE_URL || null,
  };
}

async function updateMe(ctx, b) {
  const u = await requireUser(ctx);
  u.displayName = str(b.displayName, 40) || u.discordUsername;
  u.bio = str(b.bio, 600);
  u.lookingFor = str(b.lookingFor, 300);
  u.pronouns = str(b.pronouns, 30);
  u.banner = BANNERS.includes(b.banner) ? b.banner : u.banner || 'violet';
  u.showHistory = b.showHistory === true;
  u.categories = pick(b.categories, CATEGORIES, 10);
  u.platforms = {};
  for (const p of PLATFORMS) {
    const handle = cleanHandle(p, b.platforms?.[p]);
    if (handle) u.platforms[p] = { handle, url: platformUrl(p, handle) };
  }
  if (!Object.keys(u.platforms).length) fail(400, 'Add at least one platform you create on (YouTube, Twitch, TikTok, Instagram, X / Twitter or Substack)');
  if (!u.categories.length) fail(400, 'Pick at least one content category');
  u.onboarded = true;
  await db.users.put(u);
  return getMe(ctx);
}

// ---------- profile pictures ----------
// The browser shrinks the picture to 256x256 before uploading, so these stay small.

const MAX_AVATAR_BYTES = 300_000;

async function uploadAvatar(ctx, b) {
  const u = await requireUser(ctx);
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
  if (!m) fail(400, 'Upload a PNG, JPG or WebP image');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_AVATAR_BYTES) fail(400, 'That picture is too big. Pick one under 300 KB.');
  const looksRight = m[1] === 'png' ? bytes[0] === 0x89 && bytes[1] === 0x50
    : m[1] === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!looksRight) fail(400, "That file isn't a valid image");
  const v = newId().slice(0, 8);
  await db.avatars.put(u.id, { type: `image/${m[1]}`, data: m[2], v });
  u.customAvatar = `/api/avatars/${u.id}?v=${v}`;
  await db.users.put(u);
  return getMe(ctx);
}

async function removeAvatar(ctx) {
  const u = await requireUser(ctx);
  u.customAvatar = null;
  await db.avatars.del(u.id);
  await db.users.put(u);
  return getMe(ctx);
}

async function serveAvatar(id) {
  const a = /^\d{5,25}$/.test(id) ? await db.avatars.get(id) : null;
  if (!a) return new Response('Not found', { status: 404 });
  return new Response(Buffer.from(a.data, 'base64'), {
    headers: {
      'Content-Type': a.type,
      // The URL changes (?v=) on every new upload, so browsers can cache it forever.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

async function listUsers(ctx, url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const cat = url.searchParams.get('category');
  const plat = url.searchParams.get('platform');
  let users = (await db.users.all()).filter((u) => u.onboarded);
  if (q) users = users.filter((u) => [u.displayName, u.discordUsername, u.bio, u.lookingFor].join(' ').toLowerCase().includes(q));
  if (cat) users = users.filter((u) => (u.categories || []).includes(cat));
  if (plat) users = users.filter((u) => u.platforms?.[plat]);
  users.sort((a, b) => (b.lastLoginAt || '').localeCompare(a.lastLoginAt || ''));
  return json({ users: users.slice(0, 200).map(publicUser) });
}

async function getUser(ctx, id) {
  const u = await db.users.get(id);
  if (!u || !u.onboarded) fail(404, 'Creator not found');
  const clips = (await db.clips.all()).filter(
    (c) => c.ownerId === id || c.collaborators.some((x) => x.id === id && x.status === 'confirmed')
  );
  clips.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const people = await usersById(clips.flatMap((c) => [c.ownerId, ...c.collaborators.map((x) => x.id)]));
  let friendStatus = 'none';
  if (ctx.uid === id) friendStatus = 'self';
  else if (ctx.uid && u.friendIds.includes(ctx.uid)) friendStatus = 'friends';
  else if (ctx.uid && u.friendRequestsIn.includes(ctx.uid)) friendStatus = 'requested';
  else if (ctx.uid && u.friendRequestsOut.includes(ctx.uid)) friendStatus = 'incoming';

  const self = ctx.uid === id;
  const allLobbies = await db.lobbies.all();
  // Lobbies this creator hosts that the viewer may see
  const lobbies = allLobbies.filter((l) => l.hostId === id && l.status === 'open' && canView(l, ctx.uid, u));

  // Reviews: everyone sees the ones the creator chose to show; the creator sees all of theirs.
  const allReviews = await db.reviews.all();
  const reviews = allReviews.filter((r) => r.subjectId === id && r.status === 'written' && (self || r.shown));
  let reviewStatus = null; // has the viewer asked this creator to review them?
  if (ctx.uid && !self) {
    const mine = allReviews.find((r) => r.subjectId === ctx.uid && r.authorId === id && r.status !== 'declined');
    reviewStatus = mine ? mine.status : 'none';
  }

  // Collab history: completed lobbies they were in (2+ people) where nobody flagged them.
  let history = null;
  if (self || u.showHistory) {
    const done = allLobbies.filter((l) => l.status === 'completed' && l.memberIds.includes(id) && l.memberIds.length >= 2 &&
      !(l.flags || []).some((f) => f.userId === id));
    const hosts = await usersById(done.map((l) => l.hostId));
    history = done.filter((l) => canView(l, ctx.uid, hosts[l.hostId]))
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
      .slice(0, 50);
  }
  const extra = await usersById([...reviews.map((r) => r.authorId), ...(history || []).flatMap((l) => l.memberIds)]);

  return json({
    user: publicUser(u),
    friendStatus,
    clips: clips.map((c) => clipView(c, people)),
    lobbies: lobbies.map((l) => lobbySummary(l, { [u.id]: u })),
    reviews: reviews.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt)).map((r) => reviewView(r, extra, self)),
    reviewStatus,
    showHistory: !!u.showHistory,
    history: history && history.map((l) => ({
      id: l.id, title: l.title, game: l.game, completedAt: l.completedAt, recurring: !!l.recurrence,
      host: miniUser(extra[l.hostId]),
      with: l.memberIds.filter((m) => m !== id).map((m) => miniUser(extra[m])).filter(Boolean),
    })),
  });
}

// ---------- reviews ----------
// You ask someone to review how you are to collab with. When they write it, it stays
// hidden until you choose to show it on your profile.

function reviewView(r, people, forSubject) {
  return {
    id: r.id, rating: r.rating, text: r.text, writtenAt: r.writtenAt,
    author: miniUser(people[r.authorId]),
    ...(forSubject ? { shown: !!r.shown } : {}),
  };
}

async function requestReview(ctx, targetId, b) {
  const me = await requireUser(ctx);
  if (!me.onboarded) fail(400, 'Finish your profile first');
  if (targetId === me.id) fail(400, "You can't review yourself");
  const them = await db.users.get(targetId);
  if (!them || !them.onboarded) fail(404, 'Creator not found');
  const all = await db.reviews.all();
  const between = all.filter((r) => r.subjectId === me.id && r.authorId === them.id);
  if (between.some((r) => r.status === 'requested')) fail(400, "You've already asked them. Waiting on their review.");
  if (between.some((r) => r.status === 'written')) fail(400, 'They already reviewed you');
  const declined = between.find((r) => r.status === 'declined');
  if (declined && Date.now() - Date.parse(declined.declinedAt) < 30 * 864e5) fail(400, 'They passed on your last request. You can ask again 30 days after that.');
  if (all.filter((r) => r.subjectId === me.id && r.status === 'requested').length >= 20) {
    fail(429, 'You have 20 review requests waiting. Wait for some answers first.');
  }
  if (declined) await db.reviews.del(declined.id);
  await db.reviews.put({ id: newId(), subjectId: me.id, authorId: them.id, note: str(b.note, 300), status: 'requested', createdAt: now() });
  return json({ ok: true });
}

async function reviewAction(ctx, id, action, b) {
  const me = await requireUser(ctx);
  const r = await db.reviews.get(id);
  if (!r) fail(404, 'Review not found');
  const isAuthor = r.authorId === me.id;
  const isSubject = r.subjectId === me.id;
  if (action === 'delete') {
    // the author can take back what they wrote; the subject can cancel a request or remove a review
    if (!isAuthor && !isSubject) fail(403, 'Not your review');
    await db.reviews.del(id);
    return json({ ok: true });
  }
  if (action === 'write' || action === 'decline') {
    if (!isAuthor) fail(403, 'Only the person asked can answer this');
    if (r.status !== 'requested') fail(400, 'This request was already answered');
    if (action === 'decline') {
      r.status = 'declined';
      r.declinedAt = now();
    } else {
      const rating = parseInt(b.rating, 10);
      if (!(rating >= 1 && rating <= 5)) fail(400, 'Pick 1 to 5 stars');
      r.rating = rating;
      r.text = str(b.text, 800, { required: true, name: 'Your review' });
      r.status = 'written';
      r.writtenAt = now();
      r.shown = false; // the subject decides whether it goes on their profile
      r.seen = false;
    }
  }
  if (action === 'show') {
    if (!isSubject) fail(403, 'Only the person reviewed can choose this');
    if (r.status !== 'written') fail(400, 'Nothing to show yet');
    r.shown = b.shown === true;
    r.seen = true;
  }
  await db.reviews.put(r);
  return json({ ok: true });
}

// ---------- friends ----------

async function friendAction(ctx, targetId, action) {
  const me = await requireUser(ctx);
  if (targetId === me.id) fail(400, "You can't friend yourself");
  const them = await db.users.get(targetId);
  if (!them) fail(404, 'Creator not found');
  const rm = (arr, x) => arr.filter((y) => y !== x);
  const add = (arr, x) => (arr.includes(x) ? arr : [...arr, x]);

  if (action === 'request') {
    if (me.friendIds.includes(them.id)) fail(400, 'Already friends');
    if (me.friendRequestsIn.includes(them.id)) action = 'accept'; // they already asked you
    else {
      me.friendRequestsOut = add(me.friendRequestsOut, them.id);
      them.friendRequestsIn = add(them.friendRequestsIn, me.id);
    }
  }
  if (action === 'accept') {
    if (!me.friendRequestsIn.includes(them.id)) fail(400, 'No friend request from this creator');
    me.friendRequestsIn = rm(me.friendRequestsIn, them.id);
    them.friendRequestsOut = rm(them.friendRequestsOut, me.id);
    me.friendIds = add(me.friendIds, them.id);
    them.friendIds = add(them.friendIds, me.id);
  }
  if (action === 'remove') {
    // unfriend, cancel your request, or decline theirs
    me.friendIds = rm(me.friendIds, them.id);
    them.friendIds = rm(them.friendIds, me.id);
    me.friendRequestsIn = rm(me.friendRequestsIn, them.id);
    me.friendRequestsOut = rm(me.friendRequestsOut, them.id);
    them.friendRequestsIn = rm(them.friendRequestsIn, me.id);
    them.friendRequestsOut = rm(them.friendRequestsOut, me.id);
  }
  await Promise.all([db.users.put(me), db.users.put(them)]);
  return json({ ok: true });
}

async function listFriends(ctx) {
  const me = await requireUser(ctx);
  const people = await usersById([...me.friendIds, ...me.friendRequestsIn, ...me.friendRequestsOut]);
  const map = (ids) => ids.map((id) => publicUser(people[id])).filter(Boolean);
  return json({ friends: map(me.friendIds), incoming: map(me.friendRequestsIn), outgoing: map(me.friendRequestsOut) });
}

// ---------- collab showcase (clips) ----------

function clipView(c, people) {
  return {
    ...c,
    owner: miniUser(people[c.ownerId]),
    collaborators: c.collaborators.map((x) => ({ ...x, user: miniUser(people[x.id]) })).filter((x) => x.user),
  };
}

async function createClip(ctx, b) {
  const me = await requireUser(ctx);
  if (b.attest !== true) fail(400, 'You must confirm you own this content or have explicit permission from the owner');
  const url = str(b.url, 500, { required: true, name: 'Link' });
  const media = parseMedia(url);
  if (!media) fail(400, 'Paste a YouTube video/stream link or a Twitch VOD/clip link');
  const collaborators = idList(b.collaboratorIds, 12).filter((id) => id !== me.id);
  const exist = await usersById(collaborators);
  const clip = {
    id: newId(), ownerId: me.id, url, ...media,
    title: str(b.title, 120, { required: true, name: 'Title' }),
    description: str(b.description, 500),
    ownership: b.ownership === 'permission' ? 'permission' : 'owner',
    collaborators: collaborators.filter((id) => exist[id]).map((id) => ({ id, status: 'pending' })),
    createdAt: now(),
  };
  await db.clips.put(clip);
  return json({ clip }, 201);
}

async function clipAction(ctx, id, action) {
  const me = await requireUser(ctx);
  const clip = await db.clips.get(id);
  if (!clip) fail(404, 'Not found');
  if (action === 'delete') {
    if (clip.ownerId !== me.id) fail(403, 'Only the person who added this can delete it');
    await db.clips.del(id);
    return json({ ok: true });
  }
  const tag = clip.collaborators.find((x) => x.id === me.id);
  if (!tag) fail(403, "You're not tagged on this");
  if (action === 'confirm') tag.status = 'confirmed';
  if (action === 'untag') clip.collaborators = clip.collaborators.filter((x) => x.id !== me.id);
  await db.clips.put(clip);
  return json({ ok: true });
}

// ---------- lobbies ----------

function recurrenceView(l) {
  if (!l.recurrence) return null;
  return { repeat: repeatKey(l.recurrence), until: l.recurrence.until || null, timeZone: l.recurrence.timeZone };
}

function lobbySummary(l, people) {
  const next = l.recurrence ? nextSession(l) : null;
  return {
    id: l.id, title: l.title, game: l.game, place: l.place || '', description: l.description.slice(0, 220), categories: l.categories,
    platforms: l.platforms, scheduledAt: l.scheduledAt, maxSlots: l.maxSlots, visibility: l.visibility, approval: !!l.approval,
    status: l.status, memberCount: l.memberIds.length, host: miniUser(people[l.hostId]), createdAt: l.createdAt,
    recurrence: recurrenceView(l),
    next: next ? { key: next.key, at: next.at, count: next.memberIds.length } : null,
  };
}

const guildChannelUrl = (id) => `https://discord.com/channels/${process.env.DISCORD_GUILD_ID}/${id}`;

/** The dates of a repeating lobby, with who signed up for each. */
function sessionsView(l, uid, people, manager, member) {
  const nowMs = Date.now();
  return (l.sessions || [])
    // upcoming dates, plus past ones whose channels are still around (for people in them)
    .filter((s) => !isPast(s, nowMs) || ((member || manager) && s.discord?.textId && !s.discord.deletedAt))
    .map((s) => {
      const signedUp = !!uid && s.memberIds.includes(uid);
      const room = s.discord || {};
      const links = (signedUp || manager) && room.textId && !room.deletedAt;
      return {
        key: s.key, at: s.at, past: isPast(s, nowMs), skipped: s.status === 'skipped',
        count: s.memberIds.length, signedUp,
        members: s.memberIds.map((id) => miniUser(people[id])).filter(Boolean),
        discord: links ? { textUrl: guildChannelUrl(room.textId), voiceUrl: room.voiceId ? guildChannelUrl(room.voiceId) : null } : null,
      };
    });
}

function lobbyDetail(l, uid, people) {
  const manager = isManager(l, uid);
  const member = isMember(l, uid);
  const out = {
    ...lobbySummary(l, people),
    description: l.description,
    hostId: l.hostId,
    coHosts: l.coHostIds.map((id) => miniUser(people[id])).filter(Boolean),
    members: l.memberIds.map((id) => miniUser(people[id])).filter(Boolean),
    completedAt: l.completedAt,
    me: {
      isHost: l.hostId === uid, isManager: manager, isMember: member,
      requested: !!uid && l.requestIds.includes(uid), invited: !!uid && l.invitedIds.includes(uid),
    },
    requestCount: l.requestIds.length,
    sessions: l.recurrence ? sessionsView(l, uid, people, manager, member) : null,
  };
  if (isAdmin(uid)) {
    out.flags = (l.flags || []).map((f) => ({ user: miniUser(people[f.userId]), by: miniUser(people[f.by]), reason: f.reason, at: f.at, reported: !!f.reported }));
  }
  if (manager) {
    out.code = l.visibility === 'code' ? l.code : null;
    out.requests = l.requestIds.map((id) => miniUser(people[id])).filter(Boolean);
    out.invited = l.invitedIds.map((id) => miniUser(people[id])).filter(Boolean);
  }
  if (member || manager) {
    const d = l.discord || {};
    out.discord = {
      configured: discord.discordConfigured(),
      textUrl: d.textId && !d.deletedAt ? guildChannelUrl(d.textId) : null,
      voiceUrl: d.voiceId && !d.deletedAt ? guildChannelUrl(d.voiceId) : null,
      deletedAt: d.deletedAt || null,
      // Hosts get the exact fix; members just learn something is wrong.
      error: d.error ? (manager ? d.error : 'The Discord channels could not be set up yet. The host has been shown how to fix it.') : null,
      missingAccess: (d.failedIds || []).map((id) => miniUser(people[id])).filter(Boolean),
    };
  }
  return out;
}

function readLobbyFields(b, existing) {
  // "approval" as a type is still accepted from older clients: Public + approval.
  const legacyApproval = b.visibility === 'approval';
  const visibility = legacyApproval ? 'public' : VISIBILITIES.includes(b.visibility) ? b.visibility : existing?.visibility || 'public';
  const approval = visibility !== 'code' && (legacyApproval || (b.approval !== undefined ? b.approval === true : !!existing?.approval));
  const maxSlots = Math.max(2, Math.min(100, parseInt(b.maxSlots, 10) || existing?.maxSlots || 4));
  let scheduledAt = null;
  if (b.scheduledAt) {
    const d = new Date(b.scheduledAt);
    if (!isNaN(d)) scheduledAt = d.toISOString();
  }
  // Repeating: b.repeat is a key of REPEATS ('weekly', 'biweekly', ...) or 'none'.
  let recurrence = existing?.recurrence || null;
  if (b.repeat !== undefined) {
    const rule = REPEATS[b.repeat];
    recurrence = rule ? {
      ...rule,
      timeZone: validTimeZone(b.timeZone || existing?.recurrence?.timeZone),
      until: /^\d{4}-\d{2}-\d{2}$/.test(b.repeatUntil || '') ? b.repeatUntil : null,
    } : null;
  }
  if (recurrence) {
    if (!scheduledAt) fail(400, 'Pick the date and time of the first session for a repeating lobby');
    if (recurrence.until && recurrence.until < dateKey(scheduledAt, recurrence.timeZone)) fail(400, '"Repeat until" is before the first session');
  }
  return {
    title: str(b.title, 80, { required: true, name: 'Title' }),
    game: str(b.game, 80),
    place: str(b.place, 60),
    description: str(b.description, 2000),
    categories: pick(b.categories, CATEGORIES, 6),
    platforms: pick(b.platforms, LOBBY_PLATFORMS),
    scheduledAt,
    maxSlots,
    visibility,
    approval,
    recurrence,
  };
}

/** Lobby chats live in the Discord server, so you must be in it to take part. */
async function requireInServer(user) {
  const member = await discord.isGuildMember(user.id);
  if (member === null) return; // can't check right now — don't block
  if (member !== user.inServer) { user.inServer = member; await db.users.put(user); }
  if (!member) {
    fail(409, 'Join the Create and Connect Discord server first — lobby chats and voice happen there.', 'NOT_IN_SERVER', {
      inviteUrl: process.env.DISCORD_INVITE_URL || null,
    });
  }
}

async function loadLobby(ctx, id) {
  const l = await db.lobbies.get(id);
  if (!l) fail(404, 'Lobby not found');
  const host = await db.users.get(l.hostId);
  if (!isAdmin(ctx.uid) && !canView(l, ctx.uid, host)) fail(404, 'Lobby not found');
  return { l, host };
}

/** Add the next dates of a repeating lobby; delete channels of dates that were dropped. */
async function refreshSchedule(l) {
  for (const s of syncSessionSchedule(l)) {
    await discord.deleteRoom(s.discord).catch((e) => console.error('could not delete dropped date channels', e.message));
  }
}

async function saveAndRespond(ctx, req, l, { sync = true } = {}) {
  await refreshSchedule(l);
  if (sync) await discord.syncLobbyChannels(l, siteOrigin(req));
  l.updatedAt = now();
  await db.lobbies.put(l);
  return renderLobby(ctx, l);
}

async function renderLobby(ctx, l) {
  const people = await usersById([
    l.hostId, ...l.coHostIds, ...l.memberIds, ...l.requestIds, ...l.invitedIds, ...(l.discord?.failedIds || []),
    ...(l.sessions || []).flatMap((s) => s.memberIds),
    ...(l.flags || []).flatMap((f) => [f.userId, f.by]),
  ]);
  return json({ lobby: lobbyDetail(l, ctx.uid, people) });
}

async function listLobbies(ctx, url) {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const cat = url.searchParams.get('category');
  const plat = url.searchParams.get('platform');
  const status = url.searchParams.get('status') || 'open';
  const mine = url.searchParams.get('mine') === '1';
  const all = await db.lobbies.all();
  const hosts = await usersById(all.map((l) => l.hostId));
  let lobbies = all.filter((l) => canView(l, ctx.uid, hosts[l.hostId]));
  if (mine) lobbies = lobbies.filter((l) => isMember(l, ctx.uid) || isManager(l, ctx.uid) || l.requestIds.includes(ctx.uid));
  else lobbies = lobbies.filter((l) => l.status === status);
  if (q) lobbies = lobbies.filter((l) => [l.title, l.game, l.place, l.description].join(' ').toLowerCase().includes(q));
  if (cat) lobbies = lobbies.filter((l) => l.categories.includes(cat));
  if (plat) lobbies = lobbies.filter((l) => l.platforms.includes(plat));
  // ?visibility=public,code -> any of those types (empty = all)
  const vis = (url.searchParams.get('visibility') || '').split(',').filter((v) => VISIBILITIES.includes(v));
  if (vis.length) lobbies = lobbies.filter((l) => vis.includes(l.visibility));
  // ?approval=1 -> only lobbies that need a host's OK, ?approval=0 -> only ones you can join straight away
  const appr = url.searchParams.get('approval');
  if (appr === '1' || appr === '0') lobbies = lobbies.filter((l) => !!l.approval === (appr === '1'));
  for (const l of lobbies) syncSessionSchedule(l); // in memory only: so "next date" is current
  const when = (l) => (l.recurrence && nextSession(l)?.at) || l.scheduledAt || l.createdAt;
  lobbies.sort((a, b) => when(a).localeCompare(when(b)));
  return json({ lobbies: lobbies.slice(0, 200).map((l) => lobbySummary(l, hosts)) });
}

/** A 4-digit code no other open Code lobby is using, so a code always points to one lobby. */
async function uniqueCode(exceptId) {
  const taken = new Set((await db.lobbies.all())
    .filter((l) => l.id !== exceptId && l.status === 'open' && l.visibility === 'code').map((l) => l.code));
  for (let i = 0; i < 200; i++) {
    const c = newCode();
    if (!taken.has(c)) return c;
  }
  return newCode();
}

// Codes are only 4 digits, so cap wrong guesses: 10 per 15 minutes per account.
const CODE_TRIES = 10;
const CODE_WINDOW_MS = 15 * 60 * 1000;
function checkCodeLimit(user) {
  const a = user.codeAttempts;
  if (a && Date.now() - a.start < CODE_WINDOW_MS && a.count >= CODE_TRIES) {
    const mins = Math.ceil((a.start + CODE_WINDOW_MS - Date.now()) / 60000);
    fail(429, `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
}
async function recordWrongCode(user) {
  const a = user.codeAttempts;
  user.codeAttempts = a && Date.now() - a.start < CODE_WINDOW_MS ? { ...a, count: a.count + 1 } : { start: Date.now(), count: 1 };
  await db.users.put(user);
}

/** "Have a code?" — find the open Code lobby that uses this code. */
async function findLobbyByCode(ctx, b) {
  const me = await requireUser(ctx);
  checkCodeLimit(me);
  const code = String(b.code || '').trim();
  if (!/^\d{4}$/.test(code)) fail(400, 'Codes are 4 digits');
  const match = (await db.lobbies.all()).find((l) => l.status === 'open' && l.visibility === 'code' && l.code === code);
  if (!match) {
    await recordWrongCode(me);
    fail(404, 'No open lobby uses that code. Double-check it with the host.');
  }
  return json({ id: match.id });
}

async function createLobby(ctx, req, b) {
  const me = await requireUser(ctx);
  if (!me.onboarded) fail(400, 'Finish your profile before creating a lobby');
  await requireInServer(me);
  const fields = readLobbyFields(b);
  const l = {
    id: newId(), ...fields, hostId: me.id, coHostIds: [], memberIds: [me.id], requestIds: [],
    invitedIds: [], code: '', status: 'open', createdAt: now(), updatedAt: now(), discord: {}, sessions: [],
  };
  l.code = await uniqueCode(l.id);
  l.coHostIds = idList(b.coHostIds, 5).filter((id) => id !== me.id);
  if (l.visibility === 'private') l.invitedIds = idList(b.invitedIds, 100).filter((id) => id !== me.id);
  return saveAndRespond(ctx, req, l);
}

async function lobbyAction(ctx, req, id, action, arg, b) {
  const { l, host } = await loadLobby(ctx, id);
  if (action === '' && req.method === 'GET') {
    if (l.recurrence && l.status === 'open') {
      const before = JSON.stringify(l.sessions);
      await refreshSchedule(l);
      if (JSON.stringify(l.sessions) !== before) await db.lobbies.put(l);
    }
    return renderLobby(ctx, l);
  }

  const me = await requireUser(ctx);
  const manager = isManager(l, me.id);
  const isHost = l.hostId === me.id;
  const needManager = () => { if (!manager) fail(403, 'Only the host or co-hosts can do that'); };
  const needOpen = () => { if (l.status !== 'open') fail(400, 'This lobby is no longer open'); };
  // Repeating lobbies cap each date instead of the lobby itself.
  const hasRoom = () => !!l.recurrence || l.memberIds.length < l.maxSlots;
  const session = () => {
    if (!l.recurrence) fail(400, "This lobby doesn't repeat");
    const s = (l.sessions || []).find((x) => x.key === arg);
    if (!s) fail(404, 'That date is not on the schedule');
    return s;
  };
  const dropFromSessions = (uid) => { for (const s of l.sessions || []) s.memberIds = s.memberIds.filter((x) => x !== uid); };
  const removeFrom = (key, uid) => { l[key] = l[key].filter((x) => x !== uid); };

  switch (`${req.method} ${action}`) {
    case 'PUT ': {
      needManager();
      const fields = readLobbyFields(b, l);
      if (l.recurrence && !fields.recurrence) fail(400, "A repeating lobby can't be turned into a one-time lobby. Mark it completed and create a new one instead.");
      if (!l.recurrence && fields.recurrence && l.discord?.textId) fail(400, "This lobby already has Discord channels, so it can't be made repeating. Create a new repeating lobby instead.");
      const busiest = l.recurrence
        ? Math.max(0, ...(l.sessions || []).filter((s) => !isPast(s)).map((s) => s.memberIds.length))
        : l.memberIds.length;
      if (fields.maxSlots < busiest) fail(400, `There are already ${busiest} people ${l.recurrence ? 'signed up for one of the dates' : 'in this lobby'}`);
      if (fields.visibility === 'code' && l.visibility !== 'code') l.code = await uniqueCode(l.id);
      Object.assign(l, fields);
      if (isHost && Array.isArray(b.coHostIds)) l.coHostIds = idList(b.coHostIds, 5).filter((x) => x !== l.hostId);
      break;
    }
    case 'POST join': {
      needOpen();
      if (isMember(l, me.id)) fail(400, "You're already in this lobby");
      if (!me.onboarded) fail(400, 'Finish your profile before joining lobbies');
      await requireInServer(me);
      const direct = () => { if (!hasRoom()) fail(400, 'Lobby is full'); l.memberIds.push(me.id); removeFrom('requestIds', me.id); };
      if (manager) direct();
      // With approval on, everyone else (invited people and friends too) asks and a host decides.
      else if (l.approval) { if (!l.requestIds.includes(me.id)) l.requestIds.push(me.id); }
      else if (l.invitedIds.includes(me.id)) direct();
      else if (l.visibility === 'public') direct();
      else if (l.visibility === 'friends') direct(); // canView already checked friendship
      else if (l.visibility === 'code') {
        checkCodeLimit(me);
        if (String(b.code || '').trim() !== l.code) { await recordWrongCode(me); fail(403, 'Wrong code'); }
        direct();
      } else fail(403, 'You need an invite to join this lobby');
      break;
    }
    case 'POST leave': {
      if (isHost) fail(400, 'The host cannot leave — mark the lobby completed or cancel it instead');
      removeFrom('memberIds', me.id);
      removeFrom('requestIds', me.id);
      removeFrom('coHostIds', me.id);
      dropFromSessions(me.id);
      break;
    }
    case 'POST approve': {
      needManager(); needOpen();
      if (!l.requestIds.includes(arg)) fail(404, 'No such request');
      if (!hasRoom()) fail(400, 'Lobby is full — raise the slot count first');
      removeFrom('requestIds', arg);
      removeFrom('invitedIds', arg);
      l.memberIds.push(arg);
      break;
    }
    case 'POST deny': {
      needManager();
      removeFrom('requestIds', arg);
      break;
    }
    case 'POST kick': {
      needManager();
      if (arg === l.hostId) fail(400, "Can't remove the host");
      if (l.coHostIds.includes(arg) && !isHost) fail(403, 'Only the host can remove a co-host');
      removeFrom('memberIds', arg);
      removeFrom('coHostIds', arg);
      removeFrom('invitedIds', arg);
      dropFromSessions(arg);
      break;
    }
    case 'POST signup': {
      // Sign up for one date of a repeating lobby.
      needOpen();
      const s = session();
      if (isPast(s) || s.status === 'skipped') fail(400, 'That date is not open for sign-up');
      if (s.memberIds.includes(me.id)) fail(400, "You're already signed up for that date");
      if (!me.onboarded) fail(400, 'Finish your profile before joining lobbies');
      if (!isMember(l, me.id)) {
        // Open lobbies let you sign up straight away; the others need the usual step first.
        const canJoin = manager || (!l.approval && (l.invitedIds.includes(me.id) || l.visibility === 'public' || l.visibility === 'friends'));
        if (!canJoin) {
          fail(403, l.approval ? 'Request to join first. Once a host approves you, you can pick dates.'
            : l.visibility === 'code' ? 'Enter the lobby code first, then pick your dates.'
            : 'You need an invite to join this lobby');
        }
      }
      await requireInServer(me);
      if (s.memberIds.length >= l.maxSlots) fail(400, 'That date is full');
      if (!isMember(l, me.id)) { l.memberIds.push(me.id); removeFrom('invitedIds', me.id); removeFrom('requestIds', me.id); }
      s.memberIds.push(me.id);
      break;
    }
    case 'POST withdraw': {
      const s = session();
      s.memberIds = s.memberIds.filter((x) => x !== me.id);
      break;
    }
    case 'POST skip': {
      // Host cancels one date (e.g. a holiday); its channels go away now.
      needManager();
      const s = session();
      s.status = 'skipped';
      await discord.deleteRoom(s.discord);
      break;
    }
    case 'POST unskip': {
      needManager();
      const s = session();
      if (isPast(s)) fail(400, 'That date has already passed');
      delete s.status;
      if (s.discord?.deletedAt) s.discord = {}; // fresh channels if people sign up again
      break;
    }
    case 'POST invite': {
      needManager();
      const ids = idList(b.userIds, 50);
      const found = await usersById(ids);
      for (const uid of ids) if (found[uid] && !l.invitedIds.includes(uid) && !l.memberIds.includes(uid)) l.invitedIds.push(uid);
      break;
    }
    case 'POST uninvite': {
      needManager();
      removeFrom('invitedIds', arg);
      break;
    }
    case 'POST decline-invite': {
      removeFrom('invitedIds', me.id);
      break;
    }
    case 'POST sync-discord': {
      needManager();
      break; // falls through to saveAndRespond, which re-runs the Discord sync
    }
    case 'POST regenerate-code': {
      needManager();
      l.code = await uniqueCode(l.id);
      return saveAndRespond(ctx, req, l, { sync: false });
    }
    case 'POST complete': {
      needManager(); needOpen();
      // The host (or a co-host) can flag anyone who was a problem; admins get told in Discord.
      const flags = [];
      for (const f of Array.isArray(b.flags) ? b.flags.slice(0, 100) : []) {
        const uid = String(f?.userId || '');
        if (uid === me.id) fail(400, "You can't flag yourself");
        if (!l.memberIds.includes(uid)) fail(400, 'You can only flag people who are in this lobby');
        if (flags.some((x) => x.userId === uid)) continue;
        flags.push({ userId: uid, reason: str(f.reason, 600, { required: true, name: 'A reason for each flag' }), by: me.id, at: now(), reported: false });
      }
      l.flags = [...(l.flags || []), ...flags];
      l.status = 'completed';
      l.completedAt = now();
      await reportLobbyFlags(l, siteOrigin(req)); // failures are retried by the hourly cleanup
      await discord.postToLobby(l, '✅ This lobby was marked **completed** on Create & Connect. These channels will be deleted automatically in 14 days. GG!');
      return saveAndRespond(ctx, req, l, { sync: false });
    }
    case 'POST reopen': {
      needManager();
      if (l.discord?.deletedAt) fail(400, 'Discord channels were already deleted — create a new lobby instead');
      l.status = 'open';
      l.completedAt = null;
      break;
    }
    case 'DELETE ': {
      if (!isHost) fail(403, 'Only the host can cancel the lobby');
      await discord.deleteLobbyChannels(l);
      l.status = 'cancelled';
      l.updatedAt = now();
      await db.lobbies.put(l);
      return json({ ok: true });
    }
    default:
      fail(404, 'Unknown lobby action');
  }
  return saveAndRespond(ctx, req, l);
}

// ---------- inbox ----------

async function inbox(ctx) {
  const me = await requireUser(ctx);
  const [lobbies, clips, reviews] = await Promise.all([db.lobbies.all(), db.clips.all(), db.reviews.all()]);
  const reviewRequests = reviews.filter((r) => r.authorId === me.id && r.status === 'requested');
  const newReviews = reviews.filter((r) => r.subjectId === me.id && r.status === 'written' && !r.seen);
  const invites = lobbies.filter((l) => l.status === 'open' && l.invitedIds.includes(me.id) && !l.memberIds.includes(me.id));
  const approvals = lobbies.filter((l) => l.status === 'open' && isManager(l, me.id) && l.requestIds.length);
  const tags = clips.filter((c) => c.collaborators.some((x) => x.id === me.id && x.status === 'pending'));
  const people = await usersById([
    ...me.friendRequestsIn, ...invites.map((l) => l.hostId), ...approvals.flatMap((l) => [l.hostId, ...l.requestIds]),
    ...tags.flatMap((c) => [c.ownerId, ...c.collaborators.map((x) => x.id)]),
    ...reviewRequests.map((r) => r.subjectId), ...newReviews.map((r) => r.authorId),
  ]);
  return json({
    friendRequests: me.friendRequestsIn.map((id) => publicUser(people[id])).filter(Boolean),
    invites: invites.map((l) => lobbySummary(l, people)),
    approvals: approvals.map((l) => ({ lobby: lobbySummary(l, people), requests: l.requestIds.map((id) => miniUser(people[id])).filter(Boolean) })),
    tags: tags.map((c) => clipView(c, people)),
    reviewRequests: reviewRequests.map((r) => ({ id: r.id, note: r.note, createdAt: r.createdAt, from: publicUser(people[r.subjectId]) })).filter((r) => r.from),
    newReviews: newReviews.map((r) => reviewView(r, people, true)),
  });
}

// ---------- router ----------

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const seg = path.split('/').filter(Boolean);
  const m = req.method;

  try {
    // CSRF guard: state-changing calls must be JSON (cross-site forms can't send that without CORS).
    if (m !== 'GET' && m !== 'HEAD' && !(req.headers.get('content-type') || '').includes('application/json')) {
      fail(415, 'Expected application/json');
    }
    const ctx = { uid: readSession(req) };
    const b = m === 'GET' ? {} : await body(req);

    if (path === '/auth/login' && m === 'GET') return await login(req);
    if (path === '/auth/callback' && m === 'GET') return await callback(req);
    if (path === '/auth/logout' && m === 'POST') return logout(req, ctx, b);
    if (path === '/accounts' && m === 'GET') return await listAccounts(req, ctx);
    if (path === '/accounts/switch' && m === 'POST') return await switchAccount(req, ctx, b);

    if (path === '/me' && m === 'GET') return await getMe(ctx);
    if (path === '/me' && m === 'PUT') return await updateMe(ctx, b);
    if (path === '/me/avatar' && m === 'PUT') return await uploadAvatar(ctx, b);
    if (path === '/me/avatar' && m === 'DELETE') return await removeAvatar(ctx);
    if (seg[0] === 'avatars' && seg[1] && m === 'GET') return await serveAvatar(seg[1]);
    if (path === '/inbox' && m === 'GET') return await inbox(ctx);

    if (path === '/users' && m === 'GET') return await listUsers(ctx, url);
    if (seg[0] === 'users' && seg[1] && m === 'GET') return await getUser(ctx, seg[1]);
    if (seg[0] === 'users' && seg[1] && seg[2] === 'review-request' && m === 'POST') return await requestReview(ctx, seg[1], b);
    if (seg[0] === 'reviews' && seg[1] && m === 'POST' && ['write', 'decline', 'show'].includes(seg[2])) return await reviewAction(ctx, seg[1], seg[2], b);
    if (seg[0] === 'reviews' && seg[1] && m === 'DELETE') return await reviewAction(ctx, seg[1], 'delete', b);

    if (path === '/friends' && m === 'GET') return await listFriends(ctx);
    if (seg[0] === 'friends' && seg[1] && m === 'POST' && ['request', 'accept'].includes(seg[2])) return await friendAction(ctx, seg[1], seg[2]);
    if (seg[0] === 'friends' && seg[1] && m === 'DELETE') return await friendAction(ctx, seg[1], 'remove');

    if (path === '/clips' && m === 'POST') return await createClip(ctx, b);
    if (seg[0] === 'clips' && seg[1] && m === 'DELETE') return await clipAction(ctx, seg[1], 'delete');
    if (seg[0] === 'clips' && seg[1] && m === 'POST' && ['confirm', 'untag'].includes(seg[2])) return await clipAction(ctx, seg[1], seg[2]);

    if (path === '/lobbies' && m === 'GET') return await listLobbies(ctx, url);
    if (path === '/lobbies' && m === 'POST') return await createLobby(ctx, req, b);
    if (path === '/lobby-code' && m === 'POST') return await findLobbyByCode(ctx, b);
    if (seg[0] === 'lobbies' && seg[1]) return await lobbyAction(ctx, req, seg[1], seg[2] || '', seg[3], b);

    fail(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code, ...e.extra }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong on our side' }, 500);
  }
};
