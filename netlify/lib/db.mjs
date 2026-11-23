// Storage layer on Netlify Blobs (free, built into every Netlify site — no
// separate database account needed). Each record is one JSON blob.
//
// Set CC_MEMORY_DB=1 to use an in-memory store instead (local testing only).

import { getStore } from '@netlify/blobs';

const memory = new Map();

function store(name) {
  if (process.env.CC_MEMORY_DB) {
    if (!memory.has(name)) memory.set(name, new Map());
    const m = memory.get(name);
    return {
      async get(key) { const v = m.get(key); return v === undefined ? null : structuredClone(v); },
      async setJSON(key, value) { m.set(key, structuredClone(value)); },
      async delete(key) { m.delete(key); },
      async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
    };
  }
  return getStore({ name, consistency: 'strong' });
}

async function get(name, key) {
  if (!key) return null;
  const s = store(name);
  return process.env.CC_MEMORY_DB ? s.get(key) : s.get(key, { type: 'json' });
}

async function put(name, key, value) {
  await store(name).setJSON(key, value);
  return value;
}

async function del(name, key) {
  await store(name).delete(key);
}

async function all(name) {
  const s = store(name);
  const { blobs } = await s.list();
  const items = await Promise.all(blobs.map((b) => get(name, b.key)));
  return items.filter(Boolean);
}

export const db = {
  users: {
    get: (id) => get('users', id),
    put: (u) => put('users', u.id, u),
    all: () => all('users'),
  },
  lobbies: {
    get: (id) => get('lobbies', id),
    put: (l) => put('lobbies', l.id, l),
    del: (id) => del('lobbies', id),
    all: () => all('lobbies'),
  },
  // Uploaded profile pictures: { type, data (base64), v }
  avatars: {
    get: (id) => get('avatars', id),
    put: (id, a) => put('avatars', id, a),
    del: (id) => del('avatars', id),
  },
  clips: {
    get: (id) => get('clips', id),
    put: (c) => put('clips', c.id, c),
    del: (id) => del('clips', id),
    all: () => all('clips'),
  },
};
