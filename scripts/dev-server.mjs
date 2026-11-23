// Local preview WITHOUT Discord or Netlify: in-memory database + fake logins.
//   npm install && npm run dev:local   ->  http://localhost:8888
// Use /dev/login?name=alice to sign in as a fake creator (dev only, never deployed).
// For the real thing (Discord login, Blobs, bot), use `netlify dev` instead.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CC_MEMORY_DB = '1';
process.env.SESSION_SECRET ||= 'local-dev-secret-local-dev-secret';

const { default: api } = await import('../netlify/functions/api.mjs');
const { db } = await import('../netlify/lib/db.mjs');
const { createSessionCookie, accountsCookie, readAccounts } = await import('../netlify/lib/session.mjs');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8888;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

let fakeId = 100000000000000000n;
async function devLogin(name) {
  const existing = (await db.users.all()).find((u) => u.discordUsername === name);
  if (existing) return existing;
  const id = String(fakeId++);
  const u = {
    id, discordUsername: name, discordGlobalName: name, displayName: name[0].toUpperCase() + name.slice(1),
    avatar: `https://cdn.discordapp.com/embed/avatars/${Number(fakeId % 6n)}.png`, bio: '', lookingFor: '',
    platforms: {}, categories: [], friendIds: [], friendRequestsIn: [], friendRequestsOut: [],
    onboarded: false, inServer: true, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString(),
  };
  await db.users.put(u);
  return u;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/dev/login') {
      const u = await devLogin((url.searchParams.get('name') || 'tester').toLowerCase().replace(/[^a-z0-9_.]/g, ''));
      const prev = readAccounts(new Request(url, { headers: { cookie: req.headers.cookie || '' } }));
      res.writeHead(302, {
        Location: u.onboarded ? '/#/' : '/#/me/edit?welcome=1',
        'Set-Cookie': [createSessionCookie(u.id, false), accountsCookie([u.id, ...prev], false)],
      });
      return res.end();
    }
    if (url.pathname === '/api/auth/login') {
      const name = url.searchParams.get('add') === '1' ? `creator${Math.floor(Math.random() * 1000)}` : 'tester';
      res.writeHead(302, { Location: `/dev/login?name=${name}` });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const r = await api(request);
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const setCookie = r.headers.getSetCookie?.();
      if (setCookie?.length) headers['set-cookie'] = setCookie;
      res.writeHead(r.status, headers);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end(e.code === 'ENOENT' ? 'Not found' : String(e));
  }
}).listen(PORT, () => console.log(`Create & Connect (local mock) on http://localhost:${PORT}  —  fake login: /dev/login?name=alice`));
