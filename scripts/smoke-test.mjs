// End-to-end API test with an in-memory DB and a fake Discord API.
//   npm test
import assert from 'node:assert/strict';

process.env.CC_MEMORY_DB = '1';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.DISCORD_BOT_TOKEN = 'fake';
process.env.DISCORD_GUILD_ID = '900000000000000001';
process.env.DISCORD_CLIENT_ID = '900000000000000002';

// ---- fake Discord REST ----
const calls = [];
const channels = new Map();
const notInServer = new Set();
let chanSeq = 1;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  let body = null;
  try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { /* form-encoded (OAuth) */ }
  calls.push(`${method} ${u.pathname}`);
  const reply = (status, data) => new Response(data ? JSON.stringify(data) : null, { status });
  let m;
  if (u.pathname.endsWith('/oauth2/token')) return reply(200, { access_token: 'tok' });
  if (u.pathname.endsWith('/users/@me')) return reply(200, { id: alice.id, username: 'alice', global_name: 'Alice', avatar: null });
  if ((m = u.pathname.match(/\/guilds\/\d+\/members\/(\d+)$/)) && method === 'PUT') { notInServer.delete(m[1]); return reply(201, {}); }
  if ((m = u.pathname.match(/\/guilds\/\d+\/members\/(\d+)$/)) && method === 'GET') {
    return notInServer.has(m[1]) ? reply(404, { message: 'Unknown Member', code: 10007 }) : reply(200, { user: { id: m[1] } });
  }
  if (globalThis.failVoice && method === 'POST' && body?.type === 2) return reply(403, { message: 'Missing Permissions', code: 50013 });
  if (method === 'POST' && /\/guilds\/\d+\/channels$/.test(u.pathname)) {
    const id = String(800000000000000000n + BigInt(chanSeq++));
    channels.set(id, { ...body, overwrites: new Map() });
    return reply(201, { id });
  }
  if ((m = u.pathname.match(/\/channels\/(\d+)\/permissions\/(\d+)$/))) {
    const ch = channels.get(m[1]);
    if (method === 'PUT') ch.overwrites.set(m[2], body.allow); else ch.overwrites.delete(m[2]);
    return reply(204);
  }
  if ((m = u.pathname.match(/\/channels\/(\d+)$/)) && method === 'DELETE') { channels.delete(m[1]); return reply(200, {}); }
  if ((m = u.pathname.match(/\/channels\/(\d+)$/)) && method === 'PATCH') {
    const ch = channels.get(m[1]);
    if (!ch) return reply(404, { message: 'Unknown Channel', code: 10003 });
    Object.assign(ch, body);
    return reply(200, { id: m[1] });
  }
  if (/\/channels\/\d+\/messages$/.test(u.pathname)) return reply(200, { id: '1' });
  return reply(404, { message: 'unmocked' });
};

const { default: api } = await import('../netlify/functions/api.mjs');
const { db } = await import('../netlify/lib/db.mjs');
const { createSessionCookie } = await import('../netlify/lib/session.mjs');
const { runCleanup } = await import('../netlify/functions/cleanup.mjs');

let n = 0;
async function makeUser(name) {
  const id = String(100000000000000000n + BigInt(++n));
  await db.users.put({ id, discordUsername: name, displayName: name, avatar: '', bio: '', lookingFor: '', platforms: {}, categories: [], friendIds: [], friendRequestsIn: [], friendRequestsOut: [], onboarded: false, createdAt: new Date().toISOString() });
  const cookie = createSessionCookie(id).split(';')[0];
  const call = async (method, path, body) => {
    const res = await api(new Request(`https://site.test/api${path}`, {
      method, headers: { cookie, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined,
    }));
    const data = await res.json();
    return { status: res.status, ...data };
  };
  await call('PUT', '/me', { displayName: name, platforms: { twitch: `https://twitch.tv/${name}` }, categories: ['Gaming'] });
  return { id, call };
}
const anon = async (path) => { const r = await api(new Request(`https://site.test/api${path}`)); return { status: r.status, ...(await r.json()) }; };

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

const host = await makeUser('host');
const alice = await makeUser('alice');
const bob = await makeUser('bob');
const carol = await makeUser('carol');

await test('profile saved with cleaned platform handle', async () => {
  const r = await alice.call('GET', '/me');
  assert.equal(r.user.platforms.twitch.handle, 'alice');
  assert.equal(r.user.onboarded, true);
});

await test('CSRF guard rejects non-JSON writes', async () => {
  const r = await api(new Request('https://site.test/api/lobbies', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }));
  assert.equal(r.status, 415);
});

await test('public lobby: join creates Discord text+voice at 2 members', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Mario Party', visibility: 'public', maxSlots: 3 });
  assert.equal(channels.size, 0, 'no channels with only the host');
  const r = await alice.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(r.lobby.me.isMember, true);
  assert.equal(channels.size, 3, 'category + text + voice');
  const [cat, text, voice] = [...channels.values()];
  assert.equal(cat.type, 4); assert.equal(text.type, 0); assert.equal(voice.type, 2);
  assert.equal(cat.name, 'Mario Party', 'category is named after the lobby');
  const catId = [...channels.keys()][0];
  assert.equal(text.parent_id, catId); assert.equal(voice.parent_id, catId);
  assert.ok(text.overwrites.has(host.id) && text.overwrites.has(alice.id));
  assert.ok(r.lobby.discord.textUrl.includes('/channels/900000000000000001/'));
  // anonymous viewer sees the lobby but not the Discord links
  const a = await anon(`/lobbies/${lobby.id}`);
  assert.equal(a.lobby.discord, undefined);
  // leaving revokes access
  await alice.call('POST', `/lobbies/${lobby.id}/leave`);
  assert.ok(!text.overwrites.has(alice.id));
  // full lobby
  await alice.call('POST', `/lobbies/${lobby.id}/join`);
  await bob.call('POST', `/lobbies/${lobby.id}/join`);
  const full = await carol.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(full.status, 400);
});

await test('approval lobby: request queue, host approves', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Podcast', visibility: 'approval', maxSlots: 4 });
  const r = await bob.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(r.lobby.me.isMember, false);
  assert.equal(r.lobby.me.requested, true);
  assert.equal(r.lobby.requests, undefined, 'non-hosts do not see request list');
  const denied = await alice.call('POST', `/lobbies/${lobby.id}/approve/${bob.id}`);
  assert.equal(denied.status, 403, 'non-host cannot approve');
  const inbox = await host.call('GET', '/inbox');
  assert.equal(inbox.approvals[0].requests[0].id, bob.id);
  const ok = await host.call('POST', `/lobbies/${lobby.id}/approve/${bob.id}`);
  assert.ok(ok.lobby.members.some((m) => m.id === bob.id));
});

await test('code lobby: code hidden from others, wrong/right code, regenerate', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Code night', visibility: 'code', coHostIds: [carol.id] });
  assert.match(lobby.code, /^\d{4}$/);
  const view = await alice.call('GET', `/lobbies/${lobby.id}`);
  assert.equal(view.lobby.code, undefined, 'code hidden from non-hosts');
  const cohostView = await carol.call('GET', `/lobbies/${lobby.id}`);
  assert.equal(cohostView.lobby.code, lobby.code, 'co-host sees the code');
  const wrong = await alice.call('POST', `/lobbies/${lobby.id}/join`, { code: lobby.code === '0000' ? '1111' : '0000' });
  assert.equal(wrong.status, 403);
  const regen = await carol.call('POST', `/lobbies/${lobby.id}/regenerate-code`);
  const old = await alice.call('POST', `/lobbies/${lobby.id}/join`, { code: lobby.code });
  if (regen.lobby.code !== lobby.code) assert.equal(old.status, 403, 'old code stops working');
  const right = await alice.call('POST', `/lobbies/${lobby.id}/join`, { code: regen.lobby.code });
  assert.equal(right.lobby.me.isMember, true);
});

await test('private lobby: invisible unless invited', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Secret', visibility: 'private', invitedIds: [alice.id] });
  assert.equal((await bob.call('GET', `/lobbies/${lobby.id}`)).status, 404);
  assert.equal((await anon(`/lobbies/${lobby.id}`)).status, 404);
  assert.ok(!(await bob.call('GET', '/lobbies')).lobbies.some((l) => l.id === lobby.id));
  assert.equal((await bob.call('POST', `/lobbies/${lobby.id}/join`)).status, 404);
  assert.equal((await alice.call('GET', '/inbox')).invites[0].id, lobby.id);
  const r = await alice.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(r.lobby.me.isMember, true);
});

await test('friends lobby: only host friends can see/join', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Friends only', visibility: 'friends' });
  assert.equal((await bob.call('GET', `/lobbies/${lobby.id}`)).status, 404);
  await bob.call('POST', `/friends/${host.id}/request`);
  assert.equal((await bob.call('GET', `/lobbies/${lobby.id}`)).status, 404, 'pending request is not enough');
  await host.call('POST', `/friends/${bob.id}/accept`);
  const r = await bob.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(r.lobby.me.isMember, true);
});

await test('collab showcase: attestation required, tag confirm shows on collaborator profile', async () => {
  const noAttest = await alice.call('POST', '/clips', { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'x' });
  assert.equal(noAttest.status, 400);
  const bad = await alice.call('POST', '/clips', { url: 'https://example.com/v', title: 'x', attest: true });
  assert.equal(bad.status, 400);
  const { clip } = await alice.call('POST', '/clips', { url: 'https://www.twitch.tv/videos/123456', title: 'Collab VOD', attest: true, collaboratorIds: [bob.id] });
  assert.equal(clip.platform, 'twitch');
  assert.equal((await bob.call('GET', `/users/${bob.id}`)).clips.length, 0, 'pending tag not shown yet');
  await bob.call('POST', `/clips/${clip.id}/confirm`);
  assert.equal((await bob.call('GET', `/users/${bob.id}`)).clips.length, 1);
  assert.equal((await bob.call('DELETE', `/clips/${clip.id}`)).status, 403, 'only owner can delete');
});

await test('completed lobby: channels deleted only after 14 days', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Wrap up', visibility: 'public' });
  const joined = await alice.call('POST', `/lobbies/${lobby.id}/join`);
  const textUrl = joined.lobby.discord.textUrl;
  const textId = textUrl.split('/').pop();
  assert.ok(channels.has(textId));
  await host.call('POST', `/lobbies/${lobby.id}/complete`);
  await runCleanup(Date.now() + 13 * 864e5);
  assert.ok(channels.has(textId), 'still there after 13 days');
  await runCleanup(Date.now() + 15 * 864e5);
  assert.ok(!channels.has(textId), 'deleted after 14 days');
  assert.ok(![...channels.values()].some((c) => c.type === 4 && c.name === 'Wrap up'), 'its category is deleted too');
  const after = await host.call('GET', `/lobbies/${lobby.id}`);
  assert.ok(after.lobby.discord.deletedAt);
});

await test('cancelled lobby deletes channels immediately and disappears', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Oops', visibility: 'public' });
  const j = await alice.call('POST', `/lobbies/${lobby.id}/join`);
  const textId = j.lobby.discord.textUrl.split('/').pop();
  await host.call('DELETE', `/lobbies/${lobby.id}`);
  assert.ok(!channels.has(textId));
  assert.equal((await alice.call('GET', `/lobbies/${lobby.id}`)).status, 404);
});

await test('Discord failure shows host a fix, keeps half-made channel, retry finishes it', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Flaky', visibility: 'public' });
  globalThis.failVoice = true;
  const before = channels.size;
  const j = await alice.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(channels.size, before + 2, 'category + text channel created, voice failed');
  assert.match(j.lobby.discord.error, /host/, 'member sees a generic message');
  const h = await host.call('GET', `/lobbies/${lobby.id}`);
  assert.match(h.lobby.discord.error, /Administrator/, 'host sees the actual fix');
  globalThis.failVoice = false;
  const r = await host.call('POST', `/lobbies/${lobby.id}/sync-discord`);
  assert.equal(r.lobby.discord.error, null);
  assert.equal(channels.size, before + 3, 'retry adds only the voice channel (no duplicate text or category)');
  const voiceId = r.lobby.discord.voiceUrl.split('/').pop();
  assert.ok(channels.get(voiceId).overwrites.has(alice.id), 'members get access to the new voice channel');
  assert.equal((await alice.call('POST', `/lobbies/${lobby.id}/sync-discord`)).status, 403, 'only hosts can retry');
});

await test('must be in the Discord server to join or host', async () => {
  const dave = await makeUser('dave');
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Server check', visibility: 'public' });
  notInServer.add(dave.id);
  const r = await dave.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'NOT_IN_SERVER');
  assert.equal((await dave.call('GET', `/lobbies/${lobby.id}`)).lobby.memberCount, 1, 'not added to the lobby');
  assert.equal((await dave.call('POST', '/lobbies', { title: 'Mine' })).code, 'NOT_IN_SERVER', 'also blocks hosting');
  notInServer.delete(dave.id);
  const ok = await dave.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(ok.lobby.me.isMember, true, 'joins once they are in the server');
});

await test('filter lobbies by any combination of types', async () => {
  const types = async (q) => new Set((await host.call('GET', `/lobbies?visibility=${q}`)).lobbies.map((l) => l.visibility));
  assert.deepEqual([...await types('code')], ['code']);
  assert.deepEqual([...await types('public,approval')].sort(), ['approval', 'public']);
  assert.ok((await types('')).size >= 3, 'no filter = every type');
  assert.ok(!(await bob.call('GET', '/lobbies?visibility=private')).lobbies.some((l) => l.title === 'Secret'), 'filter never reveals hidden private lobbies');
});

await test('enter a code to find its lobby; codes are unique; wrong guesses are limited', async () => {
  const a = (await host.call('POST', '/lobbies', { title: 'Code A', visibility: 'code' })).lobby;
  const b = (await host.call('POST', '/lobbies', { title: 'Code B', visibility: 'code' })).lobby;
  assert.notEqual(a.code, b.code, 'open Code lobbies never share a code');
  const found = await carol.call('POST', '/lobby-code', { code: b.code });
  assert.equal(found.id, b.id);
  assert.equal((await anon('/lobby-code')).status, 404, 'GET is not a route');
  const erin = await makeUser('erin');
  const openCodes = new Set((await db.lobbies.all()).filter((l) => l.status === 'open' && l.visibility === 'code').map((l) => l.code));
  const wrong = [...Array(10000).keys()].map((n) => String(n).padStart(4, '0')).filter((c) => !openCodes.has(c));
  for (let i = 0; i < 10; i++) assert.equal((await erin.call('POST', '/lobby-code', { code: wrong[i] })).status, 404);
  const locked = await erin.call('POST', '/lobby-code', { code: b.code });
  assert.equal(locked.status, 429, 'locked out after 10 wrong codes, even with the right one');
  assert.equal((await erin.call('POST', `/lobbies/${b.id}/join`, { code: b.code })).status, 429, 'joining is locked too');
});

async function oauthLogin(query) {
  const login = await api(new Request(`https://site.test/api/auth/login${query}`));
  const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
  const state = cookies.find((c) => c.startsWith('cc_oauth_state=')).split('=')[1];
  const before = calls.length;
  const cb = await api(new Request(`https://site.test/api/auth/callback?code=x&state=${state}`, { headers: { cookie: cookies.join('; ') } }));
  const added = calls.slice(before).some((c) => /^PUT \/api\/v10\/guilds\/\d+\/members\//.test(c));
  return { login, cookies, location: cb.headers.get('location'), added };
}

await test('plain login only checks the server, never adds you (no Discord DM)', async () => {
  const r = await oauthLogin('');
  assert.equal(r.added, false);
  assert.ok(!r.cookies.some((c) => c.startsWith('cc_join=')));
});

await test('"Add me to the server" adds you and returns you to the lobby', async () => {
  const r = await oauthLogin('?join=1&return=%23%2Flobbies%2Fabc123');
  assert.equal(r.added, true);
  assert.equal(r.location, '/#/lobbies/abc123?joined_server=1');
  const evil = await api(new Request('https://site.test/api/auth/login?return=https%3A%2F%2Fevil.example'));
  assert.ok(!evil.headers.getSetCookie().some((c) => c.startsWith('cc_return=')), 'ignores off-site return targets');
});

await test('switch accounts: only accounts signed in on this browser', async () => {
  const { accountsCookie } = await import('../netlify/lib/session.mjs');
  const jar = [createSessionCookie(alice.id), accountsCookie([alice.id, bob.id])].map((c) => c.split(';')[0]).join('; ');
  const req = (method, path, body) => api(new Request(`https://site.test/api${path}`, {
    method, headers: { cookie: jar, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  }));
  const list = await (await req('GET', '/accounts')).json();
  assert.deepEqual(list.accounts.map((a) => a.id), [alice.id, bob.id]);
  assert.equal((await req('POST', '/accounts/switch', { id: carol.id })).status, 403, 'cannot switch into an account not signed in here');
  const sw = await req('POST', '/accounts/switch', { id: bob.id });
  assert.equal(sw.status, 200);
  assert.ok(sw.headers.getSetCookie().some((c) => c.startsWith('cc_session=') && !c.includes('Max-Age=0')));
  const out = await (await req('POST', '/auth/logout', {})).json();
  assert.equal(out.switchedTo, bob.id, 'logging out alice falls back to bob');
  const all = await req('POST', '/auth/logout', { all: true });
  assert.ok(all.headers.getSetCookie().every((c) => c.includes('Max-Age=0')), 'log out of all clears both cookies');
});

await test('profile: new platforms, pronouns, banner, and an uploaded picture', async () => {
  const r = await bob.call('PUT', '/me', {
    displayName: 'Bobby', pronouns: 'he/him', banner: 'teal', categories: ['Gaming'],
    platforms: { tiktok: 'https://www.tiktok.com/@bobtok', instagram: '@bob.gram', twitter: 'x.com/bobx', substack: 'https://bob.substack.com/p/hi' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.user.pronouns, 'he/him');
  assert.equal(r.user.banner, 'teal');
  assert.equal(r.user.platforms.tiktok.url, 'https://www.tiktok.com/@bobtok');
  assert.equal(r.user.platforms.instagram.url, 'https://www.instagram.com/bob.gram');
  assert.equal(r.user.platforms.twitter.url, 'https://x.com/bobx');
  assert.equal(r.user.platforms.substack.url, 'https://bob.substack.com');
  assert.equal((await bob.call('GET', '/users?platform=substack')).users[0].id, bob.id, 'filter creators by a new platform');

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal((await bob.call('PUT', '/me/avatar', { image: 'data:image/png;base64,' + btoa('not a png') })).status, 400, 'rejects non-images');
  const up = await bob.call('PUT', '/me/avatar', { image: `data:image/png;base64,${png}` });
  assert.match(up.user.avatar, /^\/api\/avatars\/\d+\?v=/);
  assert.equal(up.user.hasCustomAvatar, true);
  const img = await api(new Request(`https://site.test${up.user.avatar}`));
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await img.arrayBuffer()).byteLength, Buffer.from(png, 'base64').length);
  assert.equal((await alice.call('GET', `/users/${bob.id}`)).user.avatar, up.user.avatar, 'others see the new picture');
  const back = await bob.call('DELETE', '/me/avatar');
  assert.equal(back.user.hasCustomAvatar, false, 'can go back to the Discord picture');
});

await test('repeating lobby: per-date sign-ups, dated Discord channels in one category', async () => {
  const first = new Date(Date.now() + 2 * 864e5); // 2 days from now
  const { lobby } = await host.call('POST', '/lobbies', {
    title: 'Smash Bros', visibility: 'public', maxSlots: 3, scheduledAt: first.toISOString(), repeat: 'biweekly', timeZone: 'America/New_York',
  });
  assert.equal(lobby.recurrence.repeat, 'biweekly');
  assert.equal(lobby.sessions.length, 6, 'next 6 dates are open for sign-up');
  const [d1, d2] = lobby.sessions;
  assert.equal(Date.parse(d2.at) - Date.parse(d1.at) >= 13 * 864e5, true, 'every 2 weeks');
  assert.ok(d1.members.some((m) => m.id === host.id), 'host is on every date');
  const before = new Set(channels.keys());
  assert.equal((await host.call('POST', `/lobbies/${lobby.id}/join`)).status, 400);

  // alice signs up for date 1 straight from a public lobby -> channels for that date only
  const r = await alice.call('POST', `/lobbies/${lobby.id}/signup/${d1.key}`);
  assert.equal(r.lobby.me.isMember, true, 'signing up joins the lobby');
  const made = [...channels.entries()].filter(([id]) => !before.has(id)).map(([id, c]) => ({ id, ...c }));
  const cat = made.find((c) => c.type === 4);
  const text = made.find((c) => c.type === 0);
  const voice = made.find((c) => c.type === 2);
  assert.equal(made.length, 3);
  assert.equal(cat.name, 'Smash Bros');
  assert.equal(text.name, `${d1.key}-smash-bros`, 'text channel starts with the date');
  assert.ok(voice.name.includes(d1.key));
  assert.equal(text.parent_id, cat.id);
  assert.ok(text.overwrites.has(alice.id) && text.overwrites.has(host.id));
  const s1 = r.lobby.sessions.find((s) => s.key === d1.key);
  assert.equal(s1.signedUp, true);
  assert.ok(s1.discord.textUrl.endsWith(text.id));
  assert.equal(r.lobby.sessions.find((s) => s.key === d2.key).discord, null, 'no channels for a date with only the host');

  // per-date slots
  await bob.call('POST', `/lobbies/${lobby.id}/signup/${d1.key}`);
  assert.equal((await carol.call('POST', `/lobbies/${lobby.id}/signup/${d1.key}`)).status, 400, 'date 1 is full');
  assert.equal((await carol.call('POST', `/lobbies/${lobby.id}/signup/${d2.key}`)).status, 200, 'date 2 still has room');

  // withdraw removes access; skip deletes that date's channels
  await bob.call('POST', `/lobbies/${lobby.id}/withdraw/${d1.key}`);
  assert.ok(!text.overwrites.has(bob.id));
  assert.equal((await alice.call('POST', `/lobbies/${lobby.id}/skip/${d1.key}`)).status, 403, 'only hosts skip dates');
  const sk = await host.call('POST', `/lobbies/${lobby.id}/skip/${d1.key}`);
  assert.equal(sk.lobby.sessions.find((s) => s.key === d1.key).skipped, true);
  assert.ok(!channels.has(text.id), 'skipped date channels deleted');
  assert.ok(channels.has(cat.id), 'category stays for the other dates');
  assert.equal((await alice.call('POST', `/lobbies/${lobby.id}/signup/${d1.key}`)).status, 400, 'cannot sign up for a skipped date');

  // leaving the lobby takes you off every date
  await carol.call('POST', `/lobbies/${lobby.id}/leave`);
  const after = await host.call('GET', `/lobbies/${lobby.id}`);
  assert.ok(!after.lobby.sessions.some((s) => s.members.some((m) => m.id === carol.id)));

  // list shows the next date
  const listed = (await anon('/lobbies')).lobbies.find((l) => l.id === lobby.id);
  assert.equal(listed.recurrence.repeat, 'biweekly');
  assert.equal(listed.next.key, d2.key, 'skipped date is not "next"');
});

await test('repeating lobby: approval still applies, and cleanup rolls dates forward', async () => {
  const first = new Date(Date.now() + 3600e3);
  const { lobby } = await host.call('POST', '/lobbies', {
    title: 'Weekly Podcast', visibility: 'approval', scheduledAt: first.toISOString(), repeat: 'weekly', timeZone: 'UTC',
  });
  const d1 = lobby.sessions[0];
  const denied = await bob.call('POST', `/lobbies/${lobby.id}/signup/${d1.key}`);
  assert.equal(denied.status, 403);
  assert.match(denied.error, /Request to join/);
  await bob.call('POST', `/lobbies/${lobby.id}/join`);
  await host.call('POST', `/lobbies/${lobby.id}/approve/${bob.id}`);
  const ok = await bob.call('POST', `/lobbies/${lobby.id}/signup/${d1.key}`);
  const textUrl = ok.lobby.sessions[0].discord.textUrl;
  const textId = textUrl.split('/').pop();
  assert.ok(channels.has(textId));

  // a date's channels live 14 days past that date; new dates keep opening
  await runCleanup(Date.now() + 10 * 864e5);
  assert.ok(channels.has(textId), 'kept 10 days later');
  await runCleanup(Date.now() + 16 * 864e5);
  assert.ok(!channels.has(textId), 'deleted 16 days later');
  const stored = await db.lobbies.get(lobby.id);
  const upcoming = stored.sessions.filter((s) => Date.parse(s.at) > Date.now() + 16 * 864e5);
  assert.equal(upcoming.length >= 5, true, 'cleanup opened later dates');

  // can't turn it back into a one-time lobby; schedule edits move dates
  assert.equal((await host.call('PUT', `/lobbies/${lobby.id}`, { title: 'Weekly Podcast', repeat: 'none' })).status, 400);
  const monthly = await host.call('PUT', `/lobbies/${lobby.id}`, { title: 'Weekly Podcast', scheduledAt: first.toISOString(), repeat: 'monthly', timeZone: 'UTC' });
  const gaps = monthly.lobby.sessions.slice(1).map((s, i) => Date.parse(s.at) - Date.parse(monthly.lobby.sessions[i].at));
  assert.ok(gaps.every((g) => g >= 28 * 864e5), 'dates follow the new monthly schedule');
});

await test('old lobbies: channels in a shared category move into the lobby\'s own category', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Old Lobby', visibility: 'public' });
  // Simulate channels made by the old version, sitting under a shared "Lobbies" category.
  const shared = '700000000000000001';
  channels.set('700000000000000002', { name: 'old-lobby', type: 0, parent_id: shared, overwrites: new Map([[host.id, '1']]) });
  channels.set('700000000000000003', { name: '🔊 Old Lobby', type: 2, parent_id: shared, overwrites: new Map([[host.id, '1']]) });
  const stored = await db.lobbies.get(lobby.id);
  stored.discord = { textId: '700000000000000002', voiceId: '700000000000000003', memberIds: [host.id] };
  await db.lobbies.put(stored);

  await runCleanup(); // the hourly job fixes it without anyone touching the lobby
  const after = await db.lobbies.get(lobby.id);
  const cat = channels.get(after.discord.categoryId);
  assert.equal(cat.type, 4);
  assert.equal(cat.name, 'Old Lobby');
  assert.equal(channels.get('700000000000000002').parent_id, after.discord.categoryId);
  assert.equal(channels.get('700000000000000003').parent_id, after.discord.categoryId);
  assert.equal(channels.get('700000000000000002').lock_permissions, false, 'keeps members-only access');

  // A channel someone deleted by hand gets made again on the next sync.
  channels.delete('700000000000000003');
  after.discord.parentId = null;
  await db.lobbies.put(after);
  const r = await host.call('POST', `/lobbies/${lobby.id}/sync-discord`);
  assert.equal(r.lobby.discord.error, null);
  const voiceId = r.lobby.discord.voiceUrl.split('/').pop();
  assert.equal(channels.get(voiceId).parent_id, after.discord.categoryId);
});

console.log(`\n${passed} tests passed (${calls.length} fake Discord calls)`);
