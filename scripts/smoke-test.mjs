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
const messages = [];
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
  if ((m = u.pathname.match(/\/channels\/(\d+)\/messages$/))) {
    if (!channels.has(m[1]) && !String(m[1]).startsWith('7')) return reply(404, { message: 'Unknown Channel', code: 10003 });
    messages.push({ channelId: m[1], ...body });
    return reply(200, { id: '1' });
  }
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
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Podcast', visibility: 'public', approval: true, maxSlots: 4 });
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

await test('approval is a setting on Public, Friends and Private, never Code', async () => {
  // Friends + approval: a friend still has to ask
  const fr = (await host.call('POST', '/lobbies', { title: 'Friends, approved', visibility: 'friends', approval: true })).lobby;
  assert.equal(fr.visibility, 'friends');
  assert.equal(fr.approval, true);
  const req = await bob.call('POST', `/lobbies/${fr.id}/join`);
  assert.equal(req.lobby.me.isMember, false);
  assert.equal(req.lobby.me.requested, true);
  assert.equal((await alice.call('GET', `/lobbies/${fr.id}`)).status, 404, 'non-friends still cannot see it');
  await host.call('POST', `/lobbies/${fr.id}/approve/${bob.id}`);
  assert.ok((await bob.call('GET', `/lobbies/${fr.id}`)).lobby.me.isMember);

  // Private + approval: an invite lets you see it and ask
  const pr = (await host.call('POST', '/lobbies', { title: 'Private, approved', visibility: 'private', approval: true, invitedIds: [alice.id] })).lobby;
  assert.equal((await bob.call('GET', `/lobbies/${pr.id}`)).status, 404);
  const ask = await alice.call('POST', `/lobbies/${pr.id}/join`);
  assert.equal(ask.lobby.me.isMember, false);
  assert.equal(ask.lobby.me.requested, true);
  const ok = await host.call('POST', `/lobbies/${pr.id}/approve/${alice.id}`);
  assert.ok(ok.lobby.members.some((m) => m.id === alice.id));
  assert.equal(ok.lobby.invited.length, 0, 'approved invitee leaves the invited list');

  // Code ignores approval: the code gets you straight in
  const cd = (await host.call('POST', '/lobbies', { title: 'Code, no approval', visibility: 'code', approval: true })).lobby;
  assert.equal(cd.approval, false);
  const inNow = await bob.call('POST', `/lobbies/${cd.id}/join`, { code: cd.code });
  assert.equal(inNow.lobby.me.isMember, true);

  // Turning approval off lets people join straight away again
  const off = await host.call('PUT', `/lobbies/${fr.id}`, { title: 'Friends, approved', visibility: 'friends', approval: false });
  assert.equal(off.lobby.approval, false);
  // Edits that don't mention approval keep it as it was
  const keep = await host.call('PUT', `/lobbies/${pr.id}`, { title: 'Private, renamed' });
  assert.equal(keep.lobby.approval, true);
});

await test('lobbies saved with the old "approval" type read as Public + approval', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Old approval lobby', visibility: 'public' });
  const raw = await db.lobbies.get(lobby.id);
  raw.visibility = 'approval'; delete raw.approval;
  await db.lobbies.put(raw);
  const view = (await bob.call('GET', `/lobbies/${lobby.id}`)).lobby;
  assert.equal(view.visibility, 'public');
  assert.equal(view.approval, true);
  const r = await bob.call('POST', `/lobbies/${lobby.id}/join`);
  assert.equal(r.lobby.me.requested, true);
  assert.equal((await db.lobbies.get(lobby.id)).visibility, 'public', 'saved in the new shape');
});

await test('optional end time, times rounded to 5 minutes', async () => {
  const start = '2030-06-01T19:02:00.000Z';
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Timed', visibility: 'public', scheduledAt: start, endsAt: '2030-06-01T21:29:00.000Z' });
  assert.equal(lobby.scheduledAt, '2030-06-01T19:00:00.000Z', 'start rounded to 5 minutes');
  assert.equal(lobby.endsAt, '2030-06-01T21:30:00.000Z', 'end rounded to 5 minutes');
  assert.equal((await host.call('POST', '/lobbies', { title: 'Backwards', scheduledAt: start, endsAt: '2030-06-01T18:00:00.000Z' })).status, 400);
  assert.equal((await host.call('POST', '/lobbies', { title: 'No start', endsAt: start })).status, 400);
  const none = (await host.call('POST', '/lobbies', { title: 'Open ended', scheduledAt: start })).lobby;
  assert.equal(none.endsAt, null, 'end time is optional');

  // repeating: every date lasts as long as the first, and can't run into the next one
  const first = new Date(Date.now() + 3600e3);
  first.setUTCMinutes(0, 0, 0);
  const rep = (await host.call('POST', '/lobbies', {
    title: 'Two hour show', scheduledAt: first.toISOString(), endsAt: new Date(+first + 2 * 3600e3).toISOString(), repeat: 'weekly', timeZone: 'UTC',
  })).lobby;
  assert.ok(rep.sessions.every((s) => Date.parse(s.endAt) - Date.parse(s.at) === 2 * 3600e3));
  assert.equal(rep.next.endAt, rep.sessions[0].endAt);
  const tooLong = await host.call('POST', '/lobbies', {
    title: 'Too long', scheduledAt: first.toISOString(), endsAt: new Date(+first + 2 * 864e5).toISOString(), repeat: 'daily', timeZone: 'UTC',
  });
  assert.equal(tooLong.status, 400);
});

await test('calendar feed: only your dates, follows later sign-ups, private link', async () => {
  const first = new Date(Date.now() + 3600e3);
  first.setUTCMinutes(0, 0, 0);
  const { lobby } = await host.call('POST', '/lobbies', {
    title: 'Sunday Podcast, Live', place: 'Online', visibility: 'public', maxSlots: 4,
    scheduledAt: first.toISOString(), endsAt: new Date(+first + 90 * 60e3).toISOString(), repeat: 'weekly', timeZone: 'UTC',
  });
  const [d1, d2, d3] = lobby.sessions;
  const joined = await bob.call('POST', `/lobbies/${lobby.id}/signup/${d1.key}`);
  const sig = joined.lobby.me.calendarSig;
  assert.ok(sig, 'members get a feed signature');
  assert.equal(joined.lobby.me.calendarSynced, false);
  const feed = async (who = bob.id, s = sig) => {
    const r = await api(new Request(`https://site.test/api/calendar/${lobby.id}/${who}/${s}.ics`));
    return { status: r.status, type: r.headers.get('content-type'), body: r.status === 200 ? await r.text() : '' };
  };
  let f = await feed();
  assert.match(f.type, /text\/calendar/);
  assert.equal((f.body.match(/BEGIN:VEVENT/g) || []).length, 1, 'only the date bob is going to');
  assert.ok(f.body.includes(`UID:${lobby.id}-${d1.key}@create-connect`));
  assert.ok(f.body.includes('SUMMARY:Sunday Podcast\\, Live'), 'commas are escaped');
  assert.ok(f.body.includes('LOCATION:Online'));
  assert.ok(f.body.includes('\r\n'), 'lines end in CRLF');

  // marking it synced, then signing up for the 3rd date adds it to the same feed
  const synced = await bob.call('POST', `/lobbies/${lobby.id}/calendar`);
  assert.equal(synced.lobby.me.calendarSynced, true);
  await bob.call('POST', `/lobbies/${lobby.id}/signup/${d3.key}`);
  f = await feed();
  assert.equal((f.body.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.ok(f.body.includes(`-${d3.key}@`) && !f.body.includes(`-${d2.key}@`), 'first and third, not second');
  // dropping a date takes it off; skipped dates are left out
  await bob.call('POST', `/lobbies/${lobby.id}/withdraw/${d1.key}`);
  await host.call('POST', `/lobbies/${lobby.id}/skip/${d3.key}`);
  f = await feed();
  assert.equal((f.body.match(/BEGIN:VEVENT/g) || []).length, 0);

  assert.equal((await feed(bob.id, 'x'.repeat(sig.length))).status, 404, 'wrong signature');
  assert.equal((await feed(alice.id, sig)).status, 404, "one person's link doesn't open another's");
});

await test('repeating lobby: host picks how many dates are open (1-9, default 6)', async () => {
  const first = new Date(Date.now() + 3600e3).toISOString();
  const base = { visibility: 'public', scheduledAt: first, repeat: 'weekly', timeZone: 'UTC' };
  const def = (await host.call('POST', '/lobbies', { ...base, title: 'Default' })).lobby;
  assert.equal(def.sessions.length, 6);
  assert.equal(def.recurrence.ahead, 6);
  const three = (await host.call('POST', '/lobbies', { ...base, title: 'Three', repeatAhead: 3 })).lobby;
  assert.equal(three.sessions.length, 3);
  assert.equal((await host.call('POST', '/lobbies', { ...base, title: 'Lots', repeatAhead: 20 })).lobby.sessions.length, 9, 'capped at 9');
  assert.equal((await host.call('POST', '/lobbies', { ...base, title: 'One', repeatAhead: 1 })).lobby.sessions.length, 1);

  // lowering it closes empty dates but keeps ones people signed up for
  const six = (await host.call('POST', '/lobbies', { ...base, title: 'Shrink' })).lobby;
  await bob.call('POST', `/lobbies/${six.id}/signup/${six.sessions[4].key}`);
  const shrunk = (await host.call('PUT', `/lobbies/${six.id}`, { ...base, title: 'Shrink', repeatAhead: 2 })).lobby;
  assert.deepEqual(shrunk.sessions.map((s) => s.key), [six.sessions[0].key, six.sessions[1].key, six.sessions[4].key]);
  // raising it opens more
  const grown = (await host.call('PUT', `/lobbies/${six.id}`, { ...base, title: 'Shrink', repeatAhead: 8 })).lobby;
  assert.equal(grown.sessions.length, 8);
});

await test('repeating lobbies from before: dates move out of the shared category into their own', async () => {
  const first = new Date(Date.now() + 2 * 864e5).toISOString();
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Legacy Series', visibility: 'public', scheduledAt: first, repeat: 'weekly', timeZone: 'UTC' });
  const key = lobby.sessions[0].key;
  // the old layout: one category for the lobby, every date's channels inside it
  const stored = await db.lobbies.get(lobby.id);
  channels.set('710000000000000001', { name: 'Legacy Series', type: 4, overwrites: new Map() });
  channels.set('710000000000000002', { name: `${key}-legacy-series`, type: 0, parent_id: '710000000000000001', overwrites: new Map([[host.id, '1']]) });
  channels.set('710000000000000003', { name: `🔊 ${key} Legacy Series`, type: 2, parent_id: '710000000000000001', overwrites: new Map([[host.id, '1']]) });
  stored.discord = { categoryId: '710000000000000001', categoryMemberIds: [host.id] };
  stored.sessions[0].discord = { textId: '710000000000000002', voiceId: '710000000000000003', parentId: '710000000000000001', memberIds: [host.id] };
  await db.lobbies.put(stored);

  await runCleanup();
  const after = await db.lobbies.get(lobby.id);
  const room = after.sessions[0].discord;
  assert.ok(room.categoryId && room.categoryId !== '710000000000000001');
  assert.equal(channels.get(room.categoryId).name, `${key} Legacy Series`);
  assert.equal(channels.get('710000000000000002').parent_id, room.categoryId);
  assert.equal(channels.get('710000000000000003').parent_id, room.categoryId);
  assert.ok(!channels.has('710000000000000001'), 'old shared category deleted');
  assert.equal(after.discord.categoryId, null);
});

await test('join questions: everyone answers, only hosts see answers, approval uses them', async () => {
  const qs = [
    { label: "What's your main channel?", type: 'short', required: true },
    { label: 'How big is your audience?', type: 'choice', options: ['Under 1k', '1k-10k', '10k+'], required: true },
    { label: 'What do you make?', type: 'multi', options: ['Streams', 'Videos', 'Podcasts'] },
    { label: 'Anything else?', type: 'long' },
  ];
  assert.equal((await host.call('POST', '/lobbies', { title: 'Bad Q', questions: [{ label: 'Pick', type: 'choice', options: ['Only one'] }] })).status, 400, 'choices need 2+ options');

  // Public: you must answer before joining
  const pub = (await host.call('POST', '/lobbies', { title: 'Q Public', visibility: 'public', maxSlots: 6, questions: qs })).lobby;
  assert.equal(pub.questions.length, 4);
  const [q1, q2, q3, q4] = pub.questions;
  assert.ok(q1.id && q1.required && !q4.required);
  const missing = await bob.call('POST', `/lobbies/${pub.id}/join`, { answers: { [q1.id]: 'bobstreams' } });
  assert.equal(missing.status, 400);
  assert.match(missing.error, /How big is your audience/);
  const badOption = await bob.call('POST', `/lobbies/${pub.id}/join`, { answers: { [q1.id]: 'bobstreams', [q2.id]: 'A million' } });
  assert.equal(badOption.status, 400, 'answers must be one of the options');
  const ok = await bob.call('POST', `/lobbies/${pub.id}/join`, { answers: { [q1.id]: 'bobstreams', [q2.id]: '1k-10k', [q3.id]: ['Streams', 'Nope', 'Videos'] } });
  assert.equal(ok.lobby.me.isMember, true);
  assert.deepEqual(ok.lobby.me.answers[q3.id], ['Streams', 'Videos'], 'unknown checkbox options dropped');
  assert.equal(ok.lobby.responses, undefined, "members don't see others' answers");
  const hostView = (await host.call('GET', `/lobbies/${pub.id}`)).lobby;
  assert.equal(hostView.responses.length, 1);
  assert.equal(hostView.responses[0].user.id, bob.id);
  assert.equal(hostView.responses[0].answers[q1.id], 'bobstreams');
  assert.equal((await alice.call('GET', `/lobbies/${pub.id}`)).lobby.questions.length, 4, 'anyone who can see the lobby sees the questions');

  // editing keeps question ids (so answers still line up); host never answers
  const edited = (await host.call('PUT', `/lobbies/${pub.id}`, { title: 'Q Public', visibility: 'public', maxSlots: 6, questions: [{ ...q1, label: 'Main channel link?' }, q2] })).lobby;
  assert.equal(edited.questions[0].id, q1.id);
  assert.equal(edited.questions.length, 2);
  // leaving forgets your answers
  await bob.call('POST', `/lobbies/${pub.id}/leave`);
  assert.equal((await host.call('GET', `/lobbies/${pub.id}`)).lobby.responses.length, 0);

  // Approval: answers come with the request, in the lobby and the Inbox
  const appr = (await host.call('POST', '/lobbies', { title: 'Q Approval', visibility: 'public', approval: true, questions: qs })).lobby;
  const [a1, a2] = appr.questions;
  assert.equal((await alice.call('POST', `/lobbies/${appr.id}/join`)).status, 400, 'no answers, no request');
  const req = await alice.call('POST', `/lobbies/${appr.id}/join`, { answers: { [a1.id]: 'alicevids', [a2.id]: '10k+' } });
  assert.equal(req.lobby.me.requested, true);
  const inbox = await host.call('GET', '/inbox');
  const entry = inbox.approvals.find((x) => x.lobby.id === appr.id);
  assert.equal(entry.questions.length, 4);
  assert.equal(entry.requests[0].answers[a2.id], '10k+');
  assert.equal((await host.call('GET', `/lobbies/${appr.id}`)).lobby.responses[0].status, 'requested');
  await host.call('POST', `/lobbies/${appr.id}/deny/${alice.id}`);
  assert.equal((await host.call('GET', `/lobbies/${appr.id}`)).lobby.responses.length, 0, 'denied answers are deleted');

  // Code: wrong code doesn't save answers; right code + answers joins
  const code = (await host.call('POST', '/lobbies', { title: 'Q Code', visibility: 'code', questions: [qs[0]] })).lobby;
  const c1 = code.questions[0].id;
  assert.equal((await carol.call('POST', `/lobbies/${code.id}/join`, { code: code.code === '0000' ? '1111' : '0000', answers: { [c1]: 'x' } })).status, 403);
  assert.equal((await carol.call('POST', `/lobbies/${code.id}/join`, { code: code.code })).status, 400, 'right code still needs answers');
  assert.equal((await carol.call('POST', `/lobbies/${code.id}/join`, { code: code.code, answers: { [c1]: 'carolcasts' } })).lobby.me.isMember, true);

  // Repeating: signing up for your first date asks the questions
  const rep = (await host.call('POST', '/lobbies', {
    title: 'Q Weekly', visibility: 'public', scheduledAt: new Date(Date.now() + 3600e3).toISOString(), repeat: 'weekly', timeZone: 'UTC', questions: [qs[0]],
  })).lobby;
  const key = rep.sessions[0].key;
  assert.equal((await bob.call('POST', `/lobbies/${rep.id}/signup/${key}`)).status, 400);
  const su = await bob.call('POST', `/lobbies/${rep.id}/signup/${key}`, { answers: { [rep.questions[0].id]: 'bobstreams' } });
  assert.equal(su.lobby.me.isMember, true);
  assert.equal((await bob.call('POST', `/lobbies/${rep.id}/signup/${rep.sessions[1].key}`)).status, 200, 'no questions again for later dates');
});

await test('filter lobbies by any combination of types', async () => {
  const types = async (q) => new Set((await host.call('GET', `/lobbies?visibility=${q}`)).lobbies.map((l) => l.visibility));
  assert.deepEqual([...await types('code')], ['code']);
  assert.deepEqual([...await types('public,code')].sort(), ['code', 'public']);
  assert.ok((await types('')).size >= 3, 'no filter = every type');
  const needs = (await host.call('GET', '/lobbies?approval=1')).lobbies;
  assert.ok(needs.length && needs.every((l) => l.approval), 'approval=1 lists only lobbies that need approval');
  assert.ok((await host.call('GET', '/lobbies?approval=0')).lobbies.every((l) => !l.approval));
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

await test('repeating lobby: per-date sign-ups, dated Discord channels, each date in its own category', async () => {
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
  assert.equal(cat.name, `${d1.key} Smash Bros`, 'the category starts with the date too');
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
  assert.ok(!channels.has(cat.id), "and that date's category");
  // date 2 gets a separate category once 2 people are on it
  await bob.call('POST', `/lobbies/${lobby.id}/signup/${d2.key}`);
  const d2room = (await db.lobbies.get(lobby.id)).sessions.find((s) => s.key === d2.key).discord;
  assert.equal(channels.get(d2room.categoryId).name, `${d2.key} Smash Bros`);
  assert.equal(channels.get(d2room.textId).parent_id, d2room.categoryId);
  assert.notEqual(d2room.categoryId, cat.id);
  assert.equal((await db.lobbies.get(lobby.id)).discord.categoryId ?? null, null, 'no shared category for the whole lobby');
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
    title: 'Weekly Podcast', visibility: 'public', approval: true, scheduledAt: first.toISOString(), repeat: 'weekly', timeZone: 'UTC',
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

await test('lobbies only offer YouTube, Twitch, TikTok and Instagram', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Platforms', platforms: ['youtube', 'twitter', 'substack', 'tiktok'] });
  assert.deepEqual(lobby.platforms, ['youtube', 'tiktok']);
  const cfg = (await anon('/me')).config;
  assert.deepEqual(cfg.lobbyPlatforms, ['youtube', 'twitch', 'tiktok', 'instagram']);
});

await test('reviews: ask, write, choose to show, others only see shown ones', async () => {
  const req = await alice.call('POST', `/users/${carol.id}/review-request`, { note: 'Thanks for the stream!' });
  assert.equal(req.status, 200);
  assert.equal((await alice.call('POST', `/users/${carol.id}/review-request`)).status, 400, 'no duplicate requests');
  assert.equal((await alice.call('POST', `/users/${alice.id}/review-request`)).status, 400, 'cannot ask yourself');
  assert.equal((await alice.call('GET', `/users/${carol.id}`)).reviewStatus, 'requested');

  const inbox = await carol.call('GET', '/inbox');
  const rq = inbox.reviewRequests.find((r) => r.from.id === alice.id);
  assert.equal(rq.note, 'Thanks for the stream!');
  assert.equal((await bob.call('POST', `/reviews/${rq.id}/write`, { rating: 5, text: 'x' })).status, 403, 'only the person asked can write it');
  assert.equal((await carol.call('POST', `/reviews/${rq.id}/write`, { rating: 9, text: 'x' })).status, 400, 'rating 1-5');
  await carol.call('POST', `/reviews/${rq.id}/write`, { rating: 4, text: 'Great energy, always on time.' });

  // hidden until alice shows it
  assert.equal((await bob.call('GET', `/users/${alice.id}`)).reviews.length, 0);
  const own = await alice.call('GET', `/users/${alice.id}`);
  assert.equal(own.reviews[0].shown, false);
  assert.equal((await alice.call('GET', '/inbox')).newReviews.length, 1, 'alice is told about the new review');
  assert.equal((await carol.call('POST', `/reviews/${rq.id}/show`, { shown: true })).status, 403, 'only the subject chooses');
  await alice.call('POST', `/reviews/${rq.id}/show`, { shown: true });
  const seen = await bob.call('GET', `/users/${alice.id}`);
  assert.equal(seen.reviews[0].rating, 4);
  assert.equal(seen.reviews[0].author.id, carol.id);
  assert.equal(seen.reviews[0].shown, undefined, 'visitors do not see show/hide state');
  assert.equal((await alice.call('GET', '/inbox')).newReviews.length, 0);

  // declining blocks re-asking for 30 days
  await bob.call('POST', `/users/${carol.id}/review-request`);
  const r2 = (await carol.call('GET', '/inbox')).reviewRequests.find((r) => r.from.id === bob.id);
  await carol.call('POST', `/reviews/${r2.id}/decline`);
  assert.match((await bob.call('POST', `/users/${carol.id}/review-request`)).error, /30 days/);
});

await test('complete with flags: admins told in a private Discord channel; flagged people lose that history', async () => {
  const dan = await makeUser('dan');
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Flag Night', visibility: 'public', maxSlots: 5 });
  for (const u of [alice, bob, dan]) await u.call('POST', `/lobbies/${lobby.id}/join`);

  assert.equal((await alice.call('POST', `/lobbies/${lobby.id}/complete`, { flags: [] })).status, 403, 'only hosts complete');
  assert.equal((await host.call('POST', `/lobbies/${lobby.id}/complete`, { flags: [{ userId: dan.id }] })).status, 400, 'a reason is required');
  assert.equal((await host.call('POST', `/lobbies/${lobby.id}/complete`, { flags: [{ userId: carol.id, reason: 'x' }] })).status, 400, 'only members');
  const before = messages.length;
  const done = await host.call('POST', `/lobbies/${lobby.id}/complete`, { flags: [{ userId: dan.id, reason: 'Kept griefing and was rude in voice' }] });
  assert.equal(done.lobby.status, 'completed');
  assert.equal(done.lobby.flags, undefined, 'hosts do not get the flag list back');

  const adminCh = [...channels.entries()].find(([, c]) => c.name === 'create-connect-reports');
  assert.ok(adminCh, 'admin channel created');
  assert.equal(adminCh[1].permission_overwrites[0].deny, String(1n << 10n), 'hidden from @everyone (admins still see it)');
  const report = messages.slice(before).find((m) => m.channelId === adminCh[0]);
  assert.match(report.content, /Flag Night/);
  assert.match(report.content, /@dan/);
  assert.match(report.content, /Kept griefing/);
  assert.deepEqual(report.allowed_mentions, { parse: [] }, 'no pings');

  // history: shown when opted in, hides lobbies where you were flagged
  await alice.call('PUT', '/me', { displayName: 'alice', platforms: { twitch: 'alice' }, categories: ['Gaming'], showHistory: true });
  const ah = await bob.call('GET', `/users/${alice.id}`);
  assert.ok(ah.history.some((h) => h.id === lobby.id));
  assert.ok(ah.history.find((h) => h.id === lobby.id).with.some((x) => x.id === host.id));
  assert.equal((await alice.call('GET', `/users/${bob.id}`)).history, null, 'bob has not opted in');
  assert.ok((await bob.call('GET', `/users/${bob.id}`)).history, 'you always see your own');
  await dan.call('PUT', '/me', { displayName: 'dan', platforms: { twitch: 'dan' }, categories: ['Gaming'], showHistory: true });
  assert.ok(!(await bob.call('GET', `/users/${dan.id}`)).history.some((h) => h.id === lobby.id), 'flagged lobby left out');

  // admins (ADMIN_DISCORD_IDS) see flags on the lobby page
  process.env.ADMIN_DISCORD_IDS = carol.id;
  const asAdmin = await carol.call('GET', `/lobbies/${lobby.id}`);
  assert.equal(asAdmin.lobby.flags[0].user.id, dan.id);
  delete process.env.ADMIN_DISCORD_IDS;
});

await test('flags that could not reach Discord are retried by the hourly cleanup', async () => {
  const { lobby } = await host.call('POST', '/lobbies', { title: 'Retry Flags', visibility: 'public' });
  await bob.call('POST', `/lobbies/${lobby.id}/join`);
  // someone deleted the admin channel; the bot makes a new one
  const old = [...channels.entries()].find(([, c]) => c.name === 'create-connect-reports')[0];
  channels.delete(old);
  await host.call('POST', `/lobbies/${lobby.id}/complete`, { flags: [{ userId: bob.id, reason: 'No-show' }] });
  const fresh = [...channels.entries()].find(([, c]) => c.name === 'create-connect-reports');
  assert.ok(fresh && fresh[0] !== old, 'new admin channel');
  assert.equal((await db.lobbies.get(lobby.id)).flags[0].reported, true);

  // Discord down: stays unreported, then cleanup sends it
  const { lobby: l2 } = await host.call('POST', '/lobbies', { title: 'Retry Flags 2', visibility: 'public' });
  await bob.call('POST', `/lobbies/${l2.id}/join`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (/messages$/.test(new URL(url).pathname) ? new Response('{}', { status: 500 }) : realFetch(url, opts));
  await host.call('POST', `/lobbies/${l2.id}/complete`, { flags: [{ userId: bob.id, reason: 'No-show again' }] });
  globalThis.fetch = realFetch;
  assert.equal((await db.lobbies.get(l2.id)).flags[0].reported, false);
  await runCleanup();
  assert.equal((await db.lobbies.get(l2.id)).flags[0].reported, true);
  assert.ok(messages.some((m) => /No-show again/.test(m.content)));
});

console.log(`\n${passed} tests passed (${calls.length} fake Discord calls)`);
