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
  assert.equal(channels.size, 2);
  const [text, voice] = [...channels.values()];
  assert.equal(text.type, 0); assert.equal(voice.type, 2);
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
  assert.equal(channels.size, before + 1, 'text channel created, voice failed');
  assert.match(j.lobby.discord.error, /host/, 'member sees a generic message');
  const h = await host.call('GET', `/lobbies/${lobby.id}`);
  assert.match(h.lobby.discord.error, /Administrator/, 'host sees the actual fix');
  globalThis.failVoice = false;
  const r = await host.call('POST', `/lobbies/${lobby.id}/sync-discord`);
  assert.equal(r.lobby.discord.error, null);
  assert.equal(channels.size, before + 2, 'retry adds only the voice channel (no duplicate text)');
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

await test('"Add me to the server" login returns you to the lobby', async () => {
  const login = await api(new Request('https://site.test/api/auth/login?return=%23%2Flobbies%2Fabc123'));
  const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]);
  assert.ok(cookies.some((c) => c.startsWith('cc_return=')));
  const state = cookies.find((c) => c.startsWith('cc_oauth_state=')).split('=')[1];
  const cb = await api(new Request(`https://site.test/api/auth/callback?code=x&state=${state}`, { headers: { cookie: cookies.join('; ') } }));
  assert.equal(cb.headers.get('location'), '/#/lobbies/abc123?joined_server=1');
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

console.log(`\n${passed} tests passed (${calls.length} fake Discord calls)`);
