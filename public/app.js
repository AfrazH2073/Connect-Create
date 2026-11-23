// Create & Connect — single-page frontend (no build step).
// Routes use the URL hash: #/lobbies, #/lobbies/<id>, #/u/<id>, ...

const $app = document.getElementById('app');
const state = { me: null, accounts: [], config: { categories: [], platforms: [], visibilities: [] }, inboxCount: 0 };

// ---------- utilities ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

/** Wrap a button click: disables it while running and reports errors. */
function act(fn) {
  return async (e) => {
    const btn = e?.currentTarget;
    if (btn) btn.disabled = true;
    try { await fn(e); } catch (err) { toast(err.message, true); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  };
}

const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const ICON = {
  youtube: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="5" fill="#ff3b3b"/><path d="M10 8.5v7l6-3.5z" fill="#fff"/></svg>',
  twitch: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2 2.5 6v14h5v3h3l3-3h4l4.5-4.5V2z" fill="#a970ff"/><path d="M6.5 4h13v10.5L17 17h-4.5l-3 3v-3h-3z" fill="#1a1628"/><path d="M11 7h2v5h-2zm5 0h2v5h-2z" fill="#a970ff"/></svg>',
  tiktok: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#111"/><path d="M13.9 5.5h2.2c.2 1.6 1.3 2.8 3 3v2.3a5.6 5.6 0 0 1-3-1v4.9a4.2 4.2 0 1 1-4.2-4.2h.4v2.3h-.4a1.9 1.9 0 1 0 1.9 1.9z" fill="#25f4ee" transform="translate(-.6 -.4)"/><path d="M13.9 5.5h2.2c.2 1.6 1.3 2.8 3 3v2.3a5.6 5.6 0 0 1-3-1v4.9a4.2 4.2 0 1 1-4.2-4.2h.4v2.3h-.4a1.9 1.9 0 1 0 1.9 1.9z" fill="#fe2c55" transform="translate(.6 .4)"/><path d="M13.9 5.5h2.2c.2 1.6 1.3 2.8 3 3v2.3a5.6 5.6 0 0 1-3-1v4.9a4.2 4.2 0 1 1-4.2-4.2h.4v2.3h-.4a1.9 1.9 0 1 0 1.9 1.9z" fill="#fff"/></svg>',
  instagram: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="igg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#feda75"/><stop offset=".35" stop-color="#fa7e1e"/><stop offset=".6" stop-color="#d62976"/><stop offset="1" stop-color="#4f5bd5"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#igg)"/><rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.1" cy="7.9" r="1" fill="#fff"/></svg>',
  twitter: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#000" stroke="#333"/><path d="M6 6h3.6l2.9 4 3.4-4h1.7l-4.3 5 4.9 7h-3.6l-3.1-4.4L7.7 18H6l4.6-5.4z" fill="#fff"/></svg>',
  substack: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#ff6719"/><path d="M6.5 6h11v1.6h-11zm0 3h11v1.6h-11zm0 3h11v6.5L12 15.6l-5.5 2.9z" fill="#fff"/></svg>',
  discord: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.8 19.8 0 0 0 6 3l1.3-2a12.8 12.8 0 0 1-2-1l.5-.4a14.1 14.1 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.7 19.7 0 0 0 6-3c.5-5.2-.8-9.7-3.6-13.7ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.4 8 10.4s2.2 1.1 2.2 2.5-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.5 2.2-2.5 2.2 1.1 2.2 2.5-1 2.4-2.2 2.4Z"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1 9.4 3.2 6 2.8 5.1 6 2 7.5l1.2 3.2L2 14l3.1 1.4L6 18.7l3.4-.4L12 20.5l2.6-2.2 3.4.4.9-3.3L22 14l-1.2-3.3L22 7.5 18.9 6 18 2.8l-3.4.4zm-1.3 14.2-3.9-3.9 1.4-1.4 2.5 2.5 5.4-5.4 1.4 1.4z"/></svg>',
  bell: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2A7 7 0 0 0 5 11v5l-2 2v1h18v-1z"/></svg>',
};

const VIS = {
  public: { label: 'Public', desc: 'Anyone can open it and take a slot.' },
  approval: { label: 'Approval', desc: 'Anyone can request a slot; a host approves.' },
  code: { label: 'Code', desc: 'Anyone can view it; joining needs a 4-digit code.' },
  private: { label: 'Private', desc: 'Only people you invite can see and join.' },
  friends: { label: 'Friends', desc: 'Only your Create & Connect friends can see and join.' },
};

const PLATFORM = {
  youtube: { label: 'YouTube', prefix: 'youtube.com/@', placeholder: 'handle or channel URL' },
  twitch: { label: 'Twitch', prefix: 'twitch.tv/', placeholder: 'username or URL' },
  tiktok: { label: 'TikTok', prefix: 'tiktok.com/@', placeholder: 'username or URL' },
  instagram: { label: 'Instagram', prefix: 'instagram.com/', placeholder: 'username or URL' },
  twitter: { label: 'X / Twitter', prefix: 'x.com/', placeholder: 'username or URL' },
  substack: { label: 'Substack', prefix: 'Substack', placeholder: 'name.substack.com or URL' },
};
const platformLabel = (p) => PLATFORM[p]?.label || p;
const platformOptions = (selected) => (state.config.platforms || []).map((p) => `<option value="${p}" ${selected === p ? 'selected' : ''}>${esc(platformLabel(p))}</option>`).join('');

const REPEAT = {
  none: "Doesn't repeat", daily: 'Every day', weekly: 'Every week', biweekly: 'Every 2 weeks',
  '3weeks': 'Every 3 weeks', '4weeks': 'Every 4 weeks', monthly: 'Every month',
};
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtKey = (key) => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const repeatText = (r) => r ? `${REPEAT[r.repeat] || 'Repeats'}${r.until ? ` until ${fmtKey(r.until)}` : ''}` : '';

const avatar = (u, size = 34) => `<img class="avatar" src="${esc(u?.avatar)}" alt="" width="${size}" height="${size}" loading="lazy" />`;
const userLine = (u, size = 34, extra = '') => u ? `
  <a class="user-line" href="#/u/${esc(u.id)}">${avatar(u, size)}
    <div class="names"><div><strong>${esc(u.displayName)}</strong> ${extra}</div><div class="handle">@${esc(u.discordUsername)}</div></div>
  </a>` : '';
// Same look as userLine but not a link — for use inside cards that are already links
// (a link inside a link makes the browser split the card in two).
const userLabel = (u, size = 34) => u ? `
  <div class="user-line">${avatar(u, size)}
    <div class="names"><div><strong>${esc(u.displayName)}</strong></div><div class="handle">@${esc(u.discordUsername)}</div></div>
  </div>` : '';
const visTag = (v) => `<span class="tag ${esc(v)}">${esc(VIS[v]?.label || v)}</span>`;
const platformChips = (ps) => (ps || []).map((p) => `<span class="chip p-${esc(p)}">${ICON[p] || ''}${esc(platformLabel(p))}</span>`).join('');
const catChips = (cs) => (cs || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
const loginUrl = '/api/auth/login';
// Mirrors how the server names Discord channels.
const slugify = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'lobby';
const loginBtn = (text = 'Log in with Discord', cls = '') => `<a class="btn discord ${cls}" href="${loginUrl}">${ICON.discord} ${esc(text)}</a>`;

function chipToggles(name, options, selected = [], label = (o) => esc(o)) {
  return `<div class="chips" data-toggle="${esc(name)}">${options.map((o) =>
    `<button type="button" class="chip${selected.includes(o) ? ' on' : ''}" data-value="${esc(o)}" aria-pressed="${selected.includes(o)}">${label(o)}</button>`).join('')}</div>`;
}
function wireToggles(root) {
  root.querySelectorAll('[data-toggle] .chip').forEach((b) => b.addEventListener('click', () => {
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', b.classList.contains('on'));
  }));
}
const readToggles = (root, name) => [...root.querySelectorAll(`[data-toggle="${name}"] .chip.on`)].map((b) => b.dataset.value);

// ---------- modal ----------

function openModal(html, { wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = root.firstElementChild;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { el: backdrop.firstElementChild, close };
}

/** In-site replacement for the browser's confirm(). Resolves true only if they click the confirm button. */
function askConfirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Never mind', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const { el, close } = openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
      <p class="muted" style="margin:0 0 22px">${esc(message)}</p>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn ghost" data-close>${esc(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'danger-solid' : 'primary'}" id="confirm-yes">${esc(confirmLabel)}</button>
      </div>`, { onClose: () => resolve(answer) });
    const yes = el.querySelector('#confirm-yes');
    yes.addEventListener('click', () => { answer = true; close(); });
    yes.focus();
  });
}

function embedUrl(c) {
  const parent = location.hostname;
  if (c.platform === 'youtube') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(c.mediaId)}?autoplay=1&rel=0`;
  if (c.kind === 'clip') return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(c.mediaId)}&parent=${parent}&autoplay=true`;
  return `https://player.twitch.tv/?video=${encodeURIComponent(c.mediaId)}&parent=${parent}&autoplay=true`;
}
function playClip(c) {
  openModal(`<iframe class="embed" src="${esc(embedUrl(c))}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${esc(c.title)}"></iframe>`, { wide: true });
}

// ---------- "join the Discord server first" prompt ----------

/** Runs fn; if the server says you're not in the Discord server yet, shows the join prompt instead. */
async function withServerCheck(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.code !== 'NOT_IN_SERVER') throw err;
    showJoinServerPrompt(err.data?.inviteUrl, fn);
    return null;
  }
}

function showJoinServerPrompt(inviteUrl, retry) {
  const back = encodeURIComponent(location.hash || '#/');
  const { el, close } = openModal(`
    <div class="modal-head"><h2 class="row" style="gap:10px">${ICON.discord} Join our Discord first</h2><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
    <p class="muted" style="margin-top:0">Every lobby gets a private text and voice channel in the <strong>Create and Connect</strong> Discord server, so you need to be in the server before you can join or host a lobby.</p>
    <a class="btn discord lg" style="width:100%" href="${loginUrl}?join=1&return=${back}">${ICON.discord} Add me to the server</a>
    <p class="hint" style="margin:8px 0 0;text-align:center">You'll approve it on Discord, then come straight back here. <strong>Using more than one Discord account?</strong> Switch Discord to the account you want first — whichever account Discord is on is the one that gets added.</p>
    ${inviteUrl ? `<p class="hint" style="text-align:center;margin:14px 0 0">Or use the <a href="${esc(inviteUrl)}" target="_blank" rel="noopener">server invite link</a>.</p>` : ''}
    <div class="menu-sep" style="margin:18px 0"></div>
    <div class="row" style="justify-content:space-between"><span class="hint">Already joined?</span><button class="btn sm" id="retry-join">I've joined — try again</button></div>`);
  el.querySelector('#retry-join').addEventListener('click', act(async () => {
    close();
    await withServerCheck(retry);
  }));
}

// ---------- user picker (search creators by name) ----------

function userPicker(el, { initial = [], exclude = [], placeholder = 'Search creators by name or Discord username…' } = {}) {
  let chosen = [...initial];
  el.innerHTML = `<div class="picker"><input type="search" placeholder="${esc(placeholder)}" autocomplete="off" /><div class="picker-results" hidden></div></div><div class="chips picker-chosen"></div>`;
  const input = el.querySelector('input');
  const results = el.querySelector('.picker-results');
  const chosenEl = el.querySelector('.picker-chosen');
  const render = () => {
    chosenEl.innerHTML = chosen.map((u) => `<span class="chip">${avatar(u, 22)} ${esc(u.displayName)} <button type="button" data-rm="${esc(u.id)}" aria-label="Remove ${esc(u.displayName)}">×</button></span>`).join('');
    chosenEl.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { chosen = chosen.filter((u) => u.id !== b.dataset.rm); render(); }));
  };
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const { users } = await api('GET', `/users?q=${encodeURIComponent(q)}`);
      const skip = new Set([...exclude, ...chosen.map((u) => u.id)]);
      const list = users.filter((u) => !skip.has(u.id)).slice(0, 8);
      results.innerHTML = list.length ? list.map((u) => `<button type="button" data-id="${esc(u.id)}">${avatar(u, 28)}<span><strong>${esc(u.displayName)}</strong> <span class="dim">@${esc(u.discordUsername)}</span></span></button>`).join('') : '<div class="dim" style="padding:10px 12px">No creators found</div>';
      results.hidden = false;
      results.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        chosen.push(list.find((u) => u.id === b.dataset.id));
        input.value = ''; results.hidden = true; render(); input.focus();
      }));
    }, 200);
  });
  input.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 200));
  render();
  return { get: () => chosen };
}

// ---------- header ----------

function renderNav(route) {
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', route.startsWith(a.dataset.nav)));
  const right = document.getElementById('nav-right');
  if (!state.me) { right.innerHTML = loginBtn('Log in', 'sm'); return; }
  const others = state.accounts.filter((a) => a.id !== state.me.id);
  right.innerHTML = `
    <a class="btn primary sm" href="#/lobbies/new">+ Lobby</a>
    <a class="icon-btn" href="#/inbox" aria-label="Inbox">${ICON.bell}${state.inboxCount ? `<span class="badge-dot">${state.inboxCount}</span>` : ''}</a>
    <div class="menu-wrap" id="me-menu">
      <button class="me-chip" type="button" aria-haspopup="true" aria-expanded="false">${avatar(state.me, 30)}<span>${esc(state.me.displayName)}</span><span class="caret" aria-hidden="true">▾</span></button>
      <div class="menu" role="menu">
        <div class="menu-head">${avatar(state.me, 36)}<div><strong>${esc(state.me.displayName)}</strong><div class="dim">@${esc(state.me.discordUsername)}</div></div></div>
        <a role="menuitem" href="#/u/${esc(state.me.id)}">View profile</a>
        <a role="menuitem" href="#/me/edit">Edit profile</a>
        <a role="menuitem" href="#/friends">Friends</a>
        <a role="menuitem" href="#/lobbies?mine=1">My lobbies</a>
        <div class="menu-sep"></div>
        <div class="menu-label">Switch account</div>
        ${others.map((a) => `<button role="menuitem" type="button" data-switch="${esc(a.id)}">${avatar(a, 24)}<span><strong>${esc(a.displayName)}</strong> <span class="dim">@${esc(a.discordUsername)}</span></span></button>`).join('')}
        <a role="menuitem" href="${loginUrl}?add=1">＋ Add another account</a>
        <div class="menu-sep"></div>
        <button role="menuitem" type="button" class="danger-item" data-logout="one">Log out${others.length ? ` of @${esc(state.me.discordUsername)}` : ''}</button>
        ${others.length ? '<button role="menuitem" type="button" class="danger-item" data-logout="all">Log out of all accounts</button>' : ''}
      </div>
    </div>`;

  const wrap = document.getElementById('me-menu');
  const toggle = wrap.querySelector('.me-chip');
  const setOpen = (open) => { wrap.classList.toggle('open', open); toggle.setAttribute('aria-expanded', open); };
  // Hover opens it on desktop (CSS); click/tap toggles it for touch screens and keyboards.
  toggle.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!wrap.classList.contains('open')); });
  wrap.querySelectorAll('a[role=menuitem]').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); toggle.focus(); } });
  wrap.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', act(async () => {
    await api('POST', '/accounts/switch', { id: b.dataset.switch });
    reloadHome();
  })));
  wrap.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', act(async () => {
    const r = await api('POST', '/auth/logout', { all: b.dataset.logout === 'all' });
    if (r.switchedTo) sessionStorage.setItem('cc_toast', 'Logged out — switched to your other account');
    reloadHome();
  })));
}

function reloadHome() {
  location.hash = '#/';
  location.reload();
}

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('me-menu');
  if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
});

async function refreshInboxCount() {
  if (!state.me) return;
  try {
    const d = await api('GET', '/inbox');
    state.inboxCount = d.friendRequests.length + d.invites.length + d.tags.length + d.approvals.reduce((n, a) => n + a.requests.length, 0);
  } catch { state.inboxCount = 0; }
}

// ---------- views ----------

function lobbyCard(l) {
  // Repeating lobbies show the next date and how many signed up for it.
  const count = l.recurrence ? (l.next?.count ?? 0) : l.memberCount;
  const pct = Math.round((count / l.maxSlots) * 100);
  const when = l.recurrence ? (l.next ? fmtDate(l.next.at) : 'No upcoming dates') : l.scheduledAt ? fmtDate(l.scheduledAt) : '';
  return `<a class="card lobby-card" href="#/lobbies/${esc(l.id)}">
    <div class="row" style="justify-content:space-between">${visTag(l.visibility)}${l.status === 'completed' ? '<span class="tag completed">Completed</span>' : ''}<span class="dim" style="font-size:.85rem">${when ? '🗓 ' + esc(when) : 'Anytime'}</span></div>
    <div>${l.game ? `<div class="game">${esc(l.game)}</div>` : ''}<h3>${esc(l.title)}</h3>${l.recurrence ? `<div class="repeat-line">🔁 ${esc(repeatText(l.recurrence))}</div>` : ''}</div>
    ${l.description ? `<p class="desc">${esc(l.description)}</p>` : ''}
    <div class="chips">${platformChips(l.platforms)}${catChips(l.categories)}</div>
    <div class="foot">${userLabel(l.host, 26)}<span class="slots" title="${l.recurrence ? 'Signed up for the next date' : 'Slots taken'}">${count}/${l.maxSlots}<span class="slot-bar"><i style="width:${pct}%"></i></span></span></div>
  </a>`;
}

function creatorCard(u) {
  return `<a class="card creator-card" href="#/u/${esc(u.id)}">
    <div class="creator-banner banner-${esc(u.banner)}"></div>
    <div class="user-line">${avatar(u, 52)}<div class="names"><div><strong>${esc(u.displayName)}</strong>${u.pronouns ? ` <span class="pronouns">${esc(u.pronouns)}</span>` : ''}</div><div class="handle">@${esc(u.discordUsername)}</div></div></div>
    <div class="chips">${platformChips(Object.keys(u.platforms))}${catChips(u.categories.slice(0, 4))}</div>
    ${u.bio ? `<p class="bio">${esc(u.bio)}</p>` : ''}
    ${u.lookingFor ? `<p class="bio" style="color:var(--text)"><strong>Looking for:</strong> ${esc(u.lookingFor)}</p>` : ''}
  </a>`;
}

async function viewHome(params) {
  if (params.get('error')) toast('Discord login failed — please try again.', true);
  const { lobbies } = await api('GET', '/lobbies');
  const top = lobbies.slice(0, 6);
  const hero = state.me ? `
    <div class="page-head"><div><h1>Hey ${esc(state.me.displayName)} 👋</h1><p>Here's what's open right now.</p></div>
    <div class="row"><a class="btn" href="#/creators">Find creators</a><a class="btn primary" href="#/lobbies/new">Create a lobby</a></div></div>` : `
    <section class="hero">
      <h1>Find your next <span>collab</span>.</h1>
      <p>Create &amp; Connect is where creators from YouTube, Twitch, TikTok, Instagram, X and Substack meet, open lobbies for streams and videos, and jump straight into a private Discord chat together.</p>
      <div class="row" style="justify-content:center">${loginBtn('Sign up with Discord', 'lg')}<a class="btn lg" href="#/lobbies">Browse lobbies</a></div>
      <div class="features">
        <div class="card"><div class="feat-icon">🎮</div><h3>Open a lobby</h3><p>Planning a "Mario Party" stream or a podcast episode? Post it, set slots and visibility, and let creators join.</p></div>
        <div class="card"><div class="feat-icon">${ICON.discord}</div><h3>Instant Discord rooms</h3><p>Once 2+ people are in, we create a private text + voice channel in the Create and Connect server just for your lobby.</p></div>
        <div class="card"><div class="feat-icon">🎬</div><h3>Show your collabs</h3><p>Pin videos and streams you've done with others so people can see how you work together.</p></div>
        <div class="card"><div class="feat-icon">✅</div><h3>Verified Discord</h3><p>Every account signs in through Discord, so the Discord tag on a profile is always really theirs.</p></div>
      </div>
    </section>`;
  $app.innerHTML = `${hero}
    <section class="section"><div class="page-head"><h2 style="margin:0">Open lobbies</h2><a class="btn sm ghost" href="#/lobbies">See all →</a></div>
    ${top.length ? `<div class="cards">${top.map(lobbyCard).join('')}</div>` : `<div class="empty">No open lobbies yet. ${state.me ? '<a href="#/lobbies/new">Start the first one!</a>' : 'Log in and start the first one!'}</div>`}</section>`;
}

async function viewLobbies(params) {
  const status = params.get('status') || 'open';
  const mine = params.get('mine') === '1';
  $app.innerHTML = `
    <div class="page-head"><div><h1>Lobbies</h1><p>Streams, videos and collabs looking for creators.</p></div>
      <div class="row">
        <form class="code-find" id="codefind" aria-label="Find a lobby by code">
          <label for="cf-code">Have a code?</label>
          <input id="cf-code" name="code" type="text" inputmode="numeric" pattern="\\d{4}" maxlength="4" placeholder="0000" required autocomplete="off" />
          <button class="btn sm">Go</button>
        </form>
        ${state.me ? '<a class="btn primary" href="#/lobbies/new">+ Create lobby</a>' : loginBtn('Log in to create')}
      </div>
    </div>
    <div class="tabs">
      <a href="#/lobbies" class="${!mine && status === 'open' ? 'active' : ''}">Open</a>
      <a href="#/lobbies?status=completed" class="${!mine && status === 'completed' ? 'active' : ''}">Completed</a>
      ${state.me ? `<a href="#/lobbies?mine=1" class="${mine ? 'active' : ''}">My lobbies</a>` : ''}
    </div>
    <form class="filters" id="f">
      <input type="search" name="q" placeholder="Search title, game, description…" value="${esc(params.get('q') || '')}" />
      <select name="category"><option value="">All categories</option>${state.config.categories.map((c) => `<option ${params.get('category') === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select name="platform"><option value="">All platforms</option>${platformOptions(params.get('platform'))}</select>
    </form>
    <div class="row vis-filter" style="margin:-8px 0 20px">
      <span class="hint">Lobby type:</span>
      <div class="chips" id="visf">${Object.entries(VIS)
        .filter(([k]) => state.me || ['public', 'approval', 'code'].includes(k)) // private/friends lobbies are only visible when logged in
        .map(([k, o]) => `<button type="button" class="chip" data-vis="${k}" aria-pressed="false" title="${esc(o.desc)}">${o.label}</button>`).join('')}</div>
      <button type="button" class="btn ghost sm" id="vis-clear" hidden>Show all types</button>
    </div>
    <div id="list"><div class="loading">Loading…</div></div>`;
  const form = document.getElementById('f');
  const visBtns = [...document.querySelectorAll('#visf .chip')];
  const clearBtn = document.getElementById('vis-clear');
  visBtns.forEach((b) => b.addEventListener('click', () => {
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', b.classList.contains('on'));
    load();
  }));
  clearBtn.addEventListener('click', () => { visBtns.forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }); load(); });

  const codeForm = document.getElementById('codefind');
  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.me) { toast('Log in with Discord to use a lobby code', true); return; }
    const code = codeForm.code.value.trim();
    const btn = codeForm.querySelector('button');
    btn.disabled = true;
    try {
      const { id } = await api('POST', '/lobby-code', { code });
      state.pendingCode = { id, code }; // pre-fills the join box on the lobby page
      location.hash = `#/lobbies/${id}`;
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });

  const load = async () => {
    const fd = new FormData(form);
    const qs = new URLSearchParams({ status, ...(mine ? { mine: '1' } : {}) });
    for (const [k, v] of fd) if (v) qs.set(k, v);
    const vis = visBtns.filter((b) => b.classList.contains('on')).map((b) => b.dataset.vis);
    if (vis.length) qs.set('visibility', vis.join(','));
    clearBtn.hidden = !vis.length;
    const { lobbies } = await api('GET', `/lobbies?${qs}`);
    document.getElementById('list').innerHTML = lobbies.length ? `<div class="cards">${lobbies.map(lobbyCard).join('')}</div>` : '<div class="empty">No lobbies match. Try different filters — or create one!</div>';
  };
  let t;
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
}

async function viewCreators(params) {
  $app.innerHTML = `
    <div class="page-head"><div><h1>Creators</h1><p>Find people to collab with by platform and content type.</p></div></div>
    <form class="filters" id="f">
      <input type="search" name="q" placeholder="Search names, bios, what they're looking for…" value="${esc(params.get('q') || '')}" />
      <select name="category"><option value="">All categories</option>${state.config.categories.map((c) => `<option ${params.get('category') === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select name="platform"><option value="">All platforms</option>${platformOptions(params.get('platform'))}</select>
    </form>
    <div id="list"><div class="loading">Loading…</div></div>`;
  const form = document.getElementById('f');
  const load = async () => {
    const qs = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) qs.set(k, v);
    const { users } = await api('GET', `/users?${qs}`);
    document.getElementById('list').innerHTML = users.length ? `<div class="cards">${users.map(creatorCard).join('')}</div>` : '<div class="empty">No creators found.</div>';
  };
  let t;
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  await load();
}

function requireLogin(msg = 'Log in with Discord to continue.') {
  $app.innerHTML = `<div class="card" style="max-width:520px;margin:40px auto;text-align:center"><h2>Log in required</h2><p class="muted">${esc(msg)}</p>${loginBtn()}</div>`;
}

/** Crop to a centred square and shrink to 256x256 so uploads stay tiny. */
async function shrinkImage(file, size = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image. Try a PNG or JPG."));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const webp = c.toDataURL('image/webp', 0.86);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function viewEditProfile(params) {
  if (!state.me) return requireLogin('Sign up with Discord to create your profile.');
  const me = state.me;
  const welcome = params.get('welcome') || !me.onboarded;
  const banners = state.config.banners || ['violet'];
  $app.innerHTML = `
    <div style="max-width:760px;margin:0 auto">
      <div class="page-head"><div><h1>${welcome ? 'Set up your creator profile' : 'Edit profile'}</h1><p>${welcome ? 'Tell other creators where you post and what you make.' : 'Make your Create &amp; Connect profile your own.'}</p></div></div>
      <form class="card" id="pf">
        <div class="field">
          <label>Profile picture</label>
          <div class="avatar-edit">
            <span id="av-preview">${avatar(me, 84)}</span>
            <div>
              <div class="row">
                <label class="btn sm" for="av-file">Upload a picture</label>
                <input type="file" id="av-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
                <button type="button" class="btn ghost sm" id="av-reset" ${me.hasCustomAvatar ? '' : 'hidden'}>Use my Discord picture</button>
              </div>
              <p class="hint" style="margin:8px 0 0">Square works best. It's cropped to a circle and saved right away.</p>
            </div>
          </div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="dn">Display name</label><input type="text" id="dn" name="displayName" maxlength="40" value="${esc(me.displayName)}" required /></div>
          <div class="field"><label for="pn">Pronouns <span class="hint">(optional)</span></label><input type="text" id="pn" name="pronouns" maxlength="30" placeholder="e.g. she/her, they/them" value="${esc(me.pronouns)}" /></div>
        </div>
        <div class="field">
          <label>Banner colour</label>
          <div class="banner-pick">${banners.map((b) => `<label class="banner-opt banner-${b}" title="${b}"><input type="radio" name="banner" value="${b}" ${me.banner === b ? 'checked' : ''} /><span class="sr-only">${b}</span></label>`).join('')}</div>
        </div>
        <div class="field">
          <label>Where do you create? <span class="hint">(at least one)</span></label>
          <div class="grid-2">
            ${(state.config.platforms || []).map((p) => `<div class="prefix-input"><span class="prefix">${ICON[p] || ''} ${esc(PLATFORM[p]?.prefix || p)}</span><input type="text" name="pl-${p}" aria-label="${esc(platformLabel(p))}" placeholder="${esc(PLATFORM[p]?.placeholder || '')}" value="${esc(me.platforms[p]?.handle || '')}" /></div>`).join('')}
          </div>
        </div>
        <div class="field"><label>What kind of content? <span class="hint">(pick up to 10)</span></label>${chipToggles('categories', state.config.categories, me.categories)}</div>
        <div class="field"><label for="bio">Bio</label><textarea id="bio" name="bio" maxlength="600" placeholder="Who are you, what's your vibe, when do you usually stream?">${esc(me.bio)}</textarea></div>
        <div class="field"><label for="lf">Looking for <span class="hint">(optional)</span></label><input type="text" id="lf" name="lookingFor" maxlength="300" placeholder="e.g. Co-op horror games on weekends, STEM explainer collabs" value="${esc(me.lookingFor)}" /></div>
        <div class="field">
          <label>Discord</label>
          <div class="notice ok row" style="justify-content:space-between">
            <span class="user-line">${ICON.discord} <span><strong>@${esc(me.discordUsername)}</strong></span></span>
            <span class="verified">${ICON.check} Verified via Discord login</span>
          </div>
          <p class="hint" style="margin-top:8px">Your Discord username always shows on your profile so people know it's really you. Everything else above is yours to change.
            ${me.inServer === true ? "You're in the Create and Connect Discord server." : me.inServer === false ? "You're not in the Create and Connect Discord server yet. You'll be asked to join when you join or host your first lobby (that's where lobby chats and voice happen)." : ''}</p>
        </div>
        <div class="row" style="justify-content:flex-end">${me.onboarded ? `<a class="btn ghost" href="#/u/${esc(me.id)}">Cancel</a>` : ''}<button class="btn primary" type="submit">Save profile</button></div>
      </form>
      ${me.onboarded ? '<div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn danger sm" id="logout">Log out</button></div>' : ''}
    </div>`;
  const form = document.getElementById('pf');
  wireToggles(form);

  const setPicture = (user) => {
    state.me = user;
    document.getElementById('av-preview').innerHTML = avatar(user, 84);
    document.getElementById('av-reset').hidden = !user.hasCustomAvatar;
    renderNav(currentRoute);
  };
  document.getElementById('av-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { user } = await api('PUT', '/me/avatar', { image: await shrinkImage(file) });
      setPicture(user);
      toast('Profile picture updated');
    } catch (err) { toast(err.message, true); }
  });
  document.getElementById('av-reset').addEventListener('click', act(async () => {
    const { user } = await api('DELETE', '/me/avatar');
    setPicture(user);
    toast('Using your Discord picture again');
  }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { user } = await api('PUT', '/me', {
        displayName: fd.get('displayName'), pronouns: fd.get('pronouns'), banner: fd.get('banner'),
        bio: fd.get('bio'), lookingFor: fd.get('lookingFor'),
        platforms: Object.fromEntries((state.config.platforms || []).map((p) => [p, fd.get(`pl-${p}`)])),
        categories: readToggles(form, 'categories'),
      });
      state.me = user;
      toast('Profile saved!');
      location.hash = `#/u/${user.id}`;
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });
  document.getElementById('logout')?.addEventListener('click', act(async () => {
    await api('POST', '/auth/logout');
    reloadHome();
  }));
}

function clipCard(c, viewerId, profileId) {
  const others = [c.owner && c.owner.id !== profileId ? { user: c.owner, status: 'confirmed' } : null, ...c.collaborators.filter((x) => x.user.id !== profileId)].filter(Boolean);
  const thumb = c.platform === 'youtube'
    ? `<button class="thumb" style="background-image:url('https://i.ytimg.com/vi/${esc(c.mediaId)}/hqdefault.jpg')" data-play="${esc(c.id)}" aria-label="Play ${esc(c.title)}">`
    : `<button class="thumb twitch-thumb" data-play="${esc(c.id)}" aria-label="Play ${esc(c.title)}">`;
  return `<div class="card clip">
    ${thumb}<span class="src chip ${c.platform === 'youtube' ? 'yt' : 'tw'}">${ICON[c.platform]} ${c.platform === 'youtube' ? 'YouTube' : c.kind === 'clip' ? 'Twitch clip' : 'Twitch VOD'}</span><span class="play"><span>▶</span></span></button>
    <div class="body">
      <h3>${esc(c.title)}</h3>
      ${c.description ? `<p class="muted" style="margin:0;font-size:.9rem">${esc(c.description)}</p>` : ''}
      ${others.length ? `<div class="with">With ${others.map((x) => `<a href="#/u/${esc(x.user.id)}" class="${x.status === 'pending' ? 'pending' : ''}" title="${x.status === 'pending' ? 'Not confirmed yet' : 'Confirmed'}">${avatar(x.user, 20)} ${esc(x.user.displayName)}${x.status === 'confirmed' ? ' ✓' : ''}</a>`).join('')}</div>` : ''}
      <div class="row" style="justify-content:space-between;margin-top:auto">
        <span class="dim" style="font-size:.8rem">${c.ownership === 'owner' ? 'Posted by the content owner' : 'Shared with owner\'s permission'}</span>
        ${c.ownerId === viewerId ? `<button class="btn danger sm" data-del-clip="${esc(c.id)}">Remove</button>` : ''}
      </div>
    </div>
  </div>`;
}

async function viewProfile(id) {
  const d = await api('GET', `/users/${encodeURIComponent(id)}`);
  const u = d.user;
  const self = state.me?.id === u.id;
  const friendBtn = !state.me || self ? '' : {
    none: `<button class="btn" data-friend="request">+ Add friend</button>`,
    requested: `<button class="btn ghost" data-friend="remove">Request sent · Cancel</button>`,
    incoming: `<button class="btn primary" data-friend="accept">Accept friend request</button>`,
    friends: `<button class="btn ghost" data-friend="remove">✓ Friends · Remove</button>`,
  }[d.friendStatus];
  $app.innerHTML = `
    <div class="card profile-card">
      <div class="profile-banner banner-${esc(u.banner)}"></div>
      <div class="profile-head">
        ${avatar(u, 104)}
        <div>
          <h1>${esc(u.displayName)}${u.pronouns ? ` <span class="pronouns">${esc(u.pronouns)}</span>` : ''}</h1>
          <div class="row" style="gap:10px;margin-top:4px"><span class="muted">${ICON.discord.replace('currentColor', '#8ea1ff')} @${esc(u.discordUsername)}</span><span class="verified">${ICON.check} Verified</span><span class="dim">· ${u.friendCount} friend${u.friendCount === 1 ? '' : 's'}</span></div>
          <div class="platform-links">${Object.entries(u.platforms).map(([p, v]) => `<a class="platform-link ${esc(p)}" href="${esc(v.url)}" target="_blank" rel="noopener" title="${esc(platformLabel(p))}">${ICON[p] || ''} ${esc(v.handle)}</a>`).join('')}</div>
        </div>
        <div class="actions">${self ? '<a class="btn" href="#/me/edit">Edit profile</a><a class="btn" href="#/friends">Friends</a>' : friendBtn}</div>
      </div>
      <div class="profile-body">
        <div class="chips">${catChips(u.categories)}</div>
        ${u.bio ? `<p class="desc-text" style="margin:16px 0 0">${esc(u.bio)}</p>` : ''}
        ${u.lookingFor ? `<p style="margin:12px 0 0"><strong>Looking for:</strong> <span class="muted">${esc(u.lookingFor)}</span></p>` : ''}
      </div>
    </div>

    <section class="section">
      <div class="page-head"><div><h2 style="margin:0">Collab showcase</h2><p>Videos &amp; streams ${esc(u.displayName)} made with other creators.</p></div>${self ? '<button class="btn primary" id="add-clip">+ Add collab</button>' : ''}</div>
      ${d.clips.length ? `<div class="cards">${d.clips.map((c) => clipCard(c, state.me?.id, u.id)).join('')}</div>` : `<div class="empty">${self ? 'Add videos or streams you did with other creators so people can see how you collab.' : 'No collabs added yet.'}</div>`}
    </section>

    ${d.lobbies.length ? `<section class="section"><h2>Open lobbies hosted by ${esc(u.displayName)}</h2><div class="cards">${d.lobbies.map(lobbyCard).join('')}</div></section>` : ''}`;

  $app.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => playClip(d.clips.find((c) => c.id === b.dataset.play))));
  $app.querySelectorAll('[data-del-clip]').forEach((b) => b.addEventListener('click', act(async () => {
    if (!await askConfirm({ title: 'Remove this collab?', message: "It will be taken off your showcase and the profiles of anyone tagged in it.", confirmLabel: 'Remove', danger: true })) return;
    await api('DELETE', `/clips/${b.dataset.delClip}`);
    toast('Removed'); route();
  })));
  $app.querySelectorAll('[data-friend]').forEach((b) => b.addEventListener('click', act(async () => {
    const a = b.dataset.friend;
    if (a === 'remove') await api('DELETE', `/friends/${u.id}`);
    else await api('POST', `/friends/${u.id}/${a}`);
    toast(a === 'request' ? 'Friend request sent' : a === 'accept' ? 'You are now friends!' : 'Updated');
    route();
  })));
  document.getElementById('add-clip')?.addEventListener('click', () => addClipModal());
}

function addClipModal() {
  const { el, close } = openModal(`
    <div class="modal-head"><h2>Add a collab video or stream</h2><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
    <form id="cf">
      <div class="field"><label for="cu">Link</label><input type="url" id="cu" name="url" required placeholder="https://youtube.com/watch?v=…  or  https://twitch.tv/videos/…" /><p class="hint">YouTube videos/streams/shorts, Twitch VODs and Twitch clips.</p></div>
      <div class="field"><label for="ct">Title</label><input type="text" id="ct" name="title" required maxlength="120" placeholder="Mario Party 4-way chaos ft. friends" /></div>
      <div class="field"><label for="cd">Notes <span class="hint">(optional)</span></label><input type="text" id="cd" name="description" maxlength="500" placeholder="What was it, how did it go?" /></div>
      <div class="field"><label>Who was in it? <span class="hint">(they'll be asked to confirm)</span></label><div id="cp"></div></div>
      <div class="field">
        <label>Ownership</label>
        <label class="check"><input type="radio" name="ownership" value="owner" checked /> I own this video/stream (it's on my channel)</label>
        <label class="check"><input type="radio" name="ownership" value="permission" /> Someone else owns it and gave me explicit permission to show it</label>
      </div>
      <div class="field"><label class="check"><input type="checkbox" name="attest" required /> I confirm I own this content or have the owner's explicit permission to display it on my profile.</label></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Add to showcase</button></div>
    </form>`);
  const picker = userPicker(el.querySelector('#cp'), { exclude: [state.me.id] });
  el.querySelector('#cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api('POST', '/clips', {
        url: fd.get('url'), title: fd.get('title'), description: fd.get('description'),
        ownership: fd.get('ownership'), attest: fd.get('attest') === 'on', collaboratorIds: picker.get().map((u) => u.id),
      });
      close(); toast('Added to your showcase'); route();
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  });
}

async function viewLobbyForm(id) {
  if (!state.me) return requireLogin('Log in to create a lobby.');
  if (!state.me.onboarded) { location.hash = '#/me/edit'; return; }
  const l = id ? (await api('GET', `/lobbies/${encodeURIComponent(id)}`)).lobby : null;
  if (l && !l.me.isManager) { toast('Only hosts can edit this lobby', true); location.hash = `#/lobbies/${id}`; return; }
  const v = l?.visibility || 'public';
  const rep0 = l?.recurrence?.repeat || 'none';
  // A repeating lobby can't go back to one-time (its dates have sign-ups and channels).
  const repeatChoices = Object.entries(REPEAT).filter(([k]) => !(l?.recurrence && k === 'none'));
  $app.innerHTML = `
    <div style="max-width:760px;margin:0 auto">
      <div class="page-head"><div><h1>${l ? 'Edit lobby' : 'Create a lobby'}</h1><p>${l ? '' : 'Post a stream, video or collab you want people for.'}</p></div></div>
      <form class="card" id="lf">
        <div class="field"><label for="t">Title</label><input type="text" id="t" name="title" required maxlength="80" placeholder="Mario Party Friday night chaos" value="${esc(l?.title)}" /></div>
        <div class="field"><label for="g">Game / activity <span class="hint">(optional)</span></label><input type="text" id="g" name="game" maxlength="80" placeholder="Mario Party Superstars" value="${esc(l?.game)}" /></div>
        <div class="repeat-box">
          <div class="grid-3">
            <div class="field"><label for="w"><span id="w-label">When</span> <span class="hint" id="w-hint">(optional, your local time)</span></label><input type="datetime-local" id="w" name="scheduledAt" value="${esc(toLocalInput(l?.scheduledAt))}" /></div>
            <div class="field"><label for="rp">Repeats</label><select id="rp" name="repeat">${repeatChoices.map(([k, label]) => `<option value="${k}" ${rep0 === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
            <div class="field" id="until-field"><label for="ru">Until <span class="hint">(optional)</span></label><input type="date" id="ru" name="repeatUntil" value="${esc(l?.recurrence?.until || '')}" /></div>
          </div>
          <p class="hint" id="repeat-hint" style="margin:0"></p>
        </div>
        <div class="field"><label for="d">Description</label><textarea id="d" name="description" maxlength="2000" placeholder="What's the plan, what are you looking for in collaborators, any requirements?">${esc(l?.description)}</textarea></div>
        <div class="grid-2">
          <div class="field"><label for="s"><span id="slots-label">Total slots</span> <span class="hint">(including you)</span></label><input type="number" id="s" name="maxSlots" min="2" max="100" value="${esc(l?.maxSlots || 4)}" /></div>
          <div class="field"><label>Streaming / posting on</label>${chipToggles('platforms', state.config.platforms || [], l?.platforms || Object.keys(state.me.platforms), (p) => `${ICON[p] || ''}${esc(platformLabel(p))}`)}</div>
        </div>
        <div class="field"><label>Categories <span class="hint">(up to 6)</span></label>${chipToggles('categories', state.config.categories, l?.categories || [])}</div>
        <div class="field">
          <label>Who can see and join?</label>
          <div class="vis-grid">${Object.entries(VIS).map(([k, o]) => `<label class="vis-opt"><input type="radio" name="visibility" value="${k}" ${v === k ? 'checked' : ''} /><strong>${o.label}</strong><span>${o.desc}</span></label>`).join('')}</div>
          <p class="hint" id="vis-hint" style="margin-top:8px"></p>
        </div>
        ${!l || l.me.isHost ? `<div class="field"><label>Co-hosts <span class="hint">(can approve, invite, edit &amp; see the code)</span></label><div id="cohosts"></div></div>` : ''}
        ${!l ? `<div class="field" id="invite-field" hidden><label>Invite creators <span class="hint">(only invited creators can see a Private lobby)</span></label><div id="invites"></div></div>` : ''}
        <div class="row" style="justify-content:flex-end"><a class="btn ghost" href="${l ? `#/lobbies/${esc(l.id)}` : '#/lobbies'}">Cancel</a><button class="btn primary" type="submit">${l ? 'Save changes' : 'Create lobby'}</button></div>
      </form>
    </div>`;
  const form = document.getElementById('lf');
  wireToggles(form);
  const hint = document.getElementById('vis-hint');
  const inviteField = document.getElementById('invite-field');
  const updateHint = () => {
    const val = form.visibility.value;
    if (inviteField) inviteField.hidden = val !== 'private';
    hint.textContent = val === 'code' ? 'A 4-digit code is generated after you save. Only you and co-hosts can see it, and you can regenerate it anytime.' : val === 'private' ? 'Only invited creators will see this lobby at all.' : val === 'friends' ? 'Only people on your friends list will see this lobby.' : '';
  };
  form.addEventListener('change', updateHint); updateHint();

  const whenInput = form.scheduledAt;
  const updateRepeat = () => {
    const r = form.repeat.value;
    const repeating = r !== 'none';
    document.getElementById('until-field').hidden = !repeating;
    whenInput.required = repeating;
    document.getElementById('w-label').textContent = repeating ? 'First date' : 'When';
    document.getElementById('w-hint').textContent = repeating ? '(your local time)' : '(optional, your local time)';
    document.getElementById('slots-label').textContent = repeating ? 'Slots per date' : 'Total slots';
    const at = whenInput.value ? new Date(whenInput.value).toISOString() : null;
    const pattern = !at ? '' : r === 'daily' ? `Every day at ${fmtTime(at)}.`
      : r === 'monthly' ? `Every month on day ${new Date(at).getDate()} at ${fmtTime(at)}.`
      : `${REPEAT[r]} on ${fmtDay(at)} at ${fmtTime(at)}.`;
    document.getElementById('repeat-hint').textContent = repeating
      ? `${pattern} People sign up for the dates they can make. Each date gets its own Discord text + voice channel, named with the date, once 2+ people sign up.`
      : '';
  };
  form.repeat.addEventListener('change', updateRepeat);
  whenInput.addEventListener('input', updateRepeat);
  updateRepeat();
  const cohostPicker = form.querySelector('#cohosts') ? userPicker(form.querySelector('#cohosts'), { initial: l?.coHosts || [], exclude: [state.me.id] }) : null;
  const invitePicker = form.querySelector('#invites') ? userPicker(form.querySelector('#invites'), { exclude: [state.me.id] }) : null;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const when = fd.get('scheduledAt');
    const payload = {
      title: fd.get('title'), game: fd.get('game'), description: fd.get('description'), maxSlots: fd.get('maxSlots'),
      visibility: fd.get('visibility'), scheduledAt: when ? new Date(when).toISOString() : null,
      platforms: readToggles(form, 'platforms'), categories: readToggles(form, 'categories'),
      repeat: fd.get('repeat'), repeatUntil: fd.get('repeatUntil') || null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    if (cohostPicker) payload.coHostIds = cohostPicker.get().map((u) => u.id);
    if (invitePicker && payload.visibility === 'private') payload.invitedIds = invitePicker.get().map((u) => u.id);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const save = async () => {
        const { lobby } = l ? await api('PUT', `/lobbies/${l.id}`, payload) : await api('POST', '/lobbies', payload);
        toast(l ? 'Lobby updated' : 'Lobby created!');
        location.hash = `#/lobbies/${lobby.id}`;
        return lobby;
      };
      await withServerCheck(save);
      btn.disabled = false;
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  });
}

async function viewLobby(id) {
  let l;
  try { l = (await api('GET', `/lobbies/${encodeURIComponent(id)}`)).lobby; } catch (e) {
    if (e.status === 404) {
      $app.innerHTML = `<div class="empty"><h2>Lobby not found</h2><p>It may be private, friends-only, or no longer exist.</p>${state.me ? '' : loginBtn('Log in — you might have access')}</div>`;
      return;
    }
    throw e;
  }
  // Recomputed on every render, since actions replace `l` with the server's latest copy.
  let me, full, open;
  const run = (fn) => act(async (e) => { const r = await fn(e); if (r?.lobby) l = r.lobby; render(); });

  function joinBox() {
    if (!open) return `<div class="notice">This lobby is ${esc(l.status)}${l.completedAt ? ' (' + esc(fmtDate(l.completedAt)) + ')' : ''}.</div>`;
    if (!state.me) return `<p class="muted">Log in to join this lobby.</p>${loginBtn()}`;
    if (!state.me.onboarded) return `<p class="muted">Finish your profile before joining.</p><a class="btn primary" href="#/me/edit">Finish profile</a>`;
    if (me.isMember && l.recurrence) return me.isHost
      ? `<div class="notice ok">You're hosting this lobby.</div><p class="hint" style="margin:10px 0 0">You're signed up for every date. Withdraw from any you'll miss, or skip a date for everyone.</p>`
      : `<div class="notice ok">You're in! 🎉</div><p class="hint" style="margin:10px 0 0">Sign up for the dates you can make below.</p><button class="btn danger sm" id="leave" style="margin-top:12px">Leave lobby</button>`;
    if (me.isMember) return me.isHost ? `<div class="notice ok">You're hosting this lobby.</div>` : `<div class="notice ok">You're in! 🎉</div><button class="btn danger sm" id="leave" style="margin-top:12px">Leave lobby</button>`;
    if (me.requested) return `<div class="notice warn">Request sent — waiting for a host to approve.</div><button class="btn ghost sm" id="leave" style="margin-top:12px">Cancel request</button>`;
    if (full && !l.recurrence) return `<div class="notice">This lobby is full.</div>`;
    if (l.recurrence && ['public', 'friends'].includes(l.visibility) && !me.invited) return `<p class="muted" style="margin:0">Pick the dates you can make in the <strong>Dates</strong> list. Signing up for a date joins the lobby.</p>`;
    if (me.invited) return `<div class="notice ok">You were invited!</div><div class="row" style="margin-top:12px"><button class="btn primary" id="join">Join lobby</button><button class="btn ghost sm" id="decline">Decline</button></div>`;
    switch (l.visibility) {
      case 'approval': return `<p class="muted">The host approves who gets a slot.</p><button class="btn primary" id="join">Request to join</button>`;
      case 'code': {
        const pre = state.pendingCode?.id === l.id ? state.pendingCode.code : '';
        return `<p class="muted">${pre ? 'Code found — hit Join to take a slot.' : 'Enter the 4-digit code from the host.'}</p><form class="row" id="codef"><input type="text" name="code" inputmode="numeric" pattern="\\d{4}" maxlength="4" placeholder="0000" required value="${esc(pre)}" style="width:110px;letter-spacing:.3em;text-align:center;font-weight:700" /><button class="btn primary">Join</button></form>`;
      }
      case 'private': return `<div class="notice">Invite only.</div>`;
      default: return `<button class="btn primary lg" id="join" style="width:100%">Join lobby</button>`;
    }
  }

  function discordBox() {
    if (!l.discord) return '';
    const dc = l.discord;
    let inner;
    if (!dc.configured) inner = '<p class="muted" style="margin:0">Discord bot isn\'t configured on this site yet.</p>';
    else if (dc.deletedAt) inner = `<p class="muted" style="margin:0">The Discord channels were deleted on ${esc(fmtDate(dc.deletedAt))}.</p>`;
    else if (dc.textUrl) inner = `
      <p class="muted" style="margin:0 0 12px">Private to lobby members in the Create and Connect server.</p>
      <div class="row"><a class="btn discord" href="${esc(dc.textUrl)}" target="_blank" rel="noopener"># Text chat</a><a class="btn discord" href="${esc(dc.voiceUrl)}" target="_blank" rel="noopener">🔊 Voice</a></div>
      ${l.status === 'completed' ? '<p class="hint" style="margin:10px 0 0">Channels are deleted 14 days after the lobby was completed.</p>' : ''}
      ${dc.missingAccess.length ? `<p class="hint" style="margin:10px 0 0">⚠️ Couldn't add ${dc.missingAccess.map((u) => esc(u.displayName)).join(', ')} — they need to join the Discord server (log out &amp; back in here).</p>` : ''}`;
    else if (l.recurrence) inner = `<p class="muted" style="margin:0">This lobby has its own category in the Create and Connect server. Each date gets a private text + voice channel named with the date (like <code>${esc(l.sessions?.[0]?.key || '2026-12-07')}-${esc(slugify(l.title))}</code>) once 2 or more people sign up for it. Links show up next to your dates.</p>`;
    else inner = '<p class="muted" style="margin:0">A private text + voice channel opens automatically once 2 or more people are in the lobby.</p>';
    const err = dc.error ? `<div class="notice warn" style="margin-top:12px">${esc(dc.error)}</div>${me.isManager ? '<button class="btn sm" id="sync-discord" style="margin-top:10px">↻ Retry Discord setup</button>' : ''}` : '';
    return `<div class="card discord-panel"><h2 class="row" style="gap:8px">${ICON.discord} Discord</h2>${inner}${err}</div>`;
  }

  function datesCard() {
    if (!l.recurrence) return '';
    const sessions = l.sessions || [];
    // Who may sign up straight away (others must join / be approved / enter the code first).
    const canPick = !!state.me && state.me.onboarded && open &&
      (me.isMember || me.isManager || me.invited || ['public', 'friends'].includes(l.visibility));
    const gate = !state.me ? 'Log in to sign up for dates.'
      : !open ? ''
      : canPick ? ''
      : l.visibility === 'approval' ? 'Request to join first. Once a host approves you, you can pick dates.'
      : l.visibility === 'code' ? 'Enter the lobby code first, then pick your dates.'
      : '';
    const row = (s) => {
      const fullDate = s.count >= l.maxSlots;
      let action = '';
      if (s.skipped) action = `<span class="tag completed">Skipped</span>${me.isManager && !s.past ? `<button class="btn ghost sm" data-unskip="${esc(s.key)}">Restore</button>` : ''}`;
      else if (s.past) action = '<span class="tag completed">Done</span>';
      else if (s.signedUp) action = `<span class="going">✓ Going</span><button class="btn ghost sm" data-withdraw="${esc(s.key)}">Can't make it</button>`;
      else if (canPick) action = fullDate ? '<span class="dim">Full</span>' : `<button class="btn primary sm" data-signup="${esc(s.key)}">Sign up</button>`;
      const skip = me.isManager && !s.skipped && !s.past ? `<button class="btn ghost sm" data-skip="${esc(s.key)}" title="Cancel this date for everyone">Skip date</button>` : '';
      const links = s.discord ? `<div class="row" style="gap:6px"><a class="btn discord sm" href="${esc(s.discord.textUrl)}" target="_blank" rel="noopener"># Chat</a>${s.discord.voiceUrl ? `<a class="btn discord sm" href="${esc(s.discord.voiceUrl)}" target="_blank" rel="noopener">🔊 Voice</a>` : ''}</div>` : '';
      return `<div class="date-row${s.skipped || s.past ? ' muted-row' : ''}">
        <div class="date-when"><strong>${esc(new Date(s.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}</strong><span class="dim">${esc(fmtTime(s.at))}</span></div>
        <div class="date-who">
          <div class="avatars">${s.members.slice(0, 6).map((u) => `<a href="#/u/${esc(u.id)}" title="${esc(u.displayName)}">${avatar(u, 26)}</a>`).join('')}${s.members.length > 6 ? `<span class="dim">+${s.members.length - 6}</span>` : ''}</div>
          <span class="dim" style="font-size:.85rem">${s.count}/${l.maxSlots} going</span>
        </div>
        <div class="date-actions">${links}${action}${skip}</div>
      </div>`;
    };
    return `<div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><h2 style="margin:0">Dates</h2><span class="dim">🔁 ${esc(repeatText(l.recurrence))}</span></div>
      ${gate ? `<div class="notice" style="margin:8px 0 4px">${esc(gate)}</div>` : ''}
      ${sessions.length ? sessions.map(row).join('') : '<p class="dim" style="margin:8px 0 0">No upcoming dates.</p>'}
      <p class="hint" style="margin:12px 0 0">New dates open automatically as old ones pass.</p>
    </div>`;
  }

  function managerBox() {
    if (!me.isManager) return '';
    return `
      ${l.visibility === 'code' ? `<div class="card"><h2>Join code</h2><div class="code-box">${esc(l.code)}</div><p class="hint">Only you and co-hosts can see this. Share it with people you want in.</p><button class="btn sm" id="regen">↻ Regenerate code</button></div>` : ''}
      ${l.requests?.length ? `<div class="card"><h2>Requests (${l.requests.length})</h2>${l.requests.map((u) => `<div class="inbox-item">${userLine(u, 30)}<div class="row"><button class="btn primary sm" data-approve="${esc(u.id)}">Approve</button><button class="btn ghost sm" data-deny="${esc(u.id)}">Deny</button></div></div>`).join('')}</div>` : ''}
      ${open && l.visibility === 'private' ? `<div class="card"><h2>Invite creators</h2><div id="inv"></div><button class="btn sm" id="send-inv" style="margin-top:10px">Send invites</button>
        ${l.invited?.length ? `<p class="hint" style="margin:14px 0 6px">Invited, not joined yet:</p>${l.invited.map((u) => `<div class="inbox-item">${userLine(u, 26)}<button class="btn ghost sm" data-uninvite="${esc(u.id)}">Revoke</button></div>`).join('')}` : ''}</div>` : ''}
      <div class="card"><h2>Manage</h2><div class="row">
        <a class="btn sm" href="#/lobbies/${esc(l.id)}/edit">Edit</a>
        ${open ? '<button class="btn sm" id="complete">✓ Mark completed</button>' : l.status === 'completed' && !l.discord?.deletedAt ? '<button class="btn sm" id="reopen">Reopen</button>' : ''}
        ${me.isHost ? '<button class="btn danger sm" id="cancel">Cancel lobby</button>' : ''}
      </div></div>`;
  }

  function render() {
    me = l.me;
    full = l.memberCount >= l.maxSlots;
    open = l.status === 'open';
    const slotsLeft = Math.max(0, l.maxSlots - l.members.length);
    $app.innerHTML = `
      <a href="#/lobbies" class="dim" style="text-decoration:none">← All lobbies</a>
      <div class="lobby-layout" style="margin-top:12px">
        <div>
          <div class="card">
            <div class="row">${visTag(l.visibility)}${l.status !== 'open' ? `<span class="tag completed">${esc(l.status)}</span>` : ''}${platformChips(l.platforms)}</div>
            ${l.game ? `<div style="color:var(--accent-2);font-weight:600;margin-top:14px">${esc(l.game)}</div>` : ''}
            <h1 class="lobby-title">${esc(l.title)}</h1>
            <div class="meta-row">${l.recurrence
              ? `<span>🔁 ${esc(repeatText(l.recurrence))}</span><span>🗓 ${l.next ? `Next: ${esc(fmtDate(l.next.at))}` : 'No upcoming dates'}</span><span>👥 ${l.memberCount} member${l.memberCount === 1 ? '' : 's'} · ${l.maxSlots} per date</span>`
              : `<span>🗓 ${l.scheduledAt ? esc(fmtDate(l.scheduledAt)) : 'No set time'}</span><span>👥 ${l.memberCount}/${l.maxSlots} slots</span>`}${l.visibility === 'approval' && l.requestCount ? `<span>⏳ ${l.requestCount} pending</span>` : ''}</div>
            <div class="chips">${catChips(l.categories)}</div>
            ${l.description ? `<p class="desc-text" style="margin-top:18px">${esc(l.description)}</p>` : ''}
          </div>
          ${datesCard()}
          <div class="card">
            <h2>Hosted by</h2>
            <div class="row" style="gap:24px">${userLine(l.host, 40, '<span class="tag code" style="margin-left:4px">Host</span>')}${l.coHosts.map((u) => userLine(u, 40, '<span class="tag friends" style="margin-left:4px">Co-host</span>')).join('')}</div>
          </div>
          <div class="card">
            <h2>${l.recurrence ? `Members (${l.members.length})` : `Who's in (${l.members.length}/${l.maxSlots})`}</h2>
            <div class="member-list">
              ${l.members.map((u) => `<div class="member">${userLine(u, 34)}${me.isManager && u.id !== l.hostId && u.id !== state.me?.id ? `<button class="btn ghost sm" data-kick="${esc(u.id)}">Remove</button>` : ''}</div>`).join('')}
              ${l.recurrence ? '' : Array.from({ length: Math.min(slotsLeft, 8) }, () => '<div class="open-slot"><i></i>Open slot</div>').join('')}
              ${!l.recurrence && slotsLeft > 8 ? `<div class="dim">+ ${slotsLeft - 8} more open slots</div>` : ''}
            </div>
          </div>
        </div>
        <aside class="side-stack">
          <div class="card">${joinBox()}</div>
          ${discordBox()}
          ${managerBox()}
        </aside>
      </div>`;

    const base = `/lobbies/${l.id}`;
    const on = (sel, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener('click', run(fn)); };
    on('#join', () => withServerCheck(async () => {
      const r = await api('POST', `${base}/join`);
      l = r.lobby; render();
      toast(r.lobby.me.isMember ? 'Joined!' : 'Request sent');
      refreshInboxCount().then(() => renderNav(currentRoute));
      return r;
    }));
    on('#leave', () => api('POST', `${base}/leave`));
    on('#decline', async () => { await api('POST', `${base}/decline-invite`); location.hash = '#/inbox'; });
    on('#sync-discord', async () => {
      const r = await api('POST', `${base}/sync-discord`);
      toast(r.lobby.discord?.error ? 'Still failing — see the message' : 'Discord channels are set up!', !!r.lobby.discord?.error);
      return r;
    });
    on('#regen', async () => { const r = await api('POST', `${base}/regenerate-code`); toast('New code generated'); return r; });
    on('#complete', async () => {
      const ok = await askConfirm({
        title: 'Mark this lobby as completed?',
        message: l.recurrence
          ? 'No new dates will open, and its Discord channels and category will be deleted in 14 days. You can reopen it before then.'
          : 'Its Discord channels will be deleted in 14 days. You can reopen it before then.',
        confirmLabel: 'Mark completed',
      });
      if (!ok) return;
      return api('POST', `${base}/complete`);
    });
    on('#reopen', () => api('POST', `${base}/reopen`));
    on('#cancel', async () => {
      const ok = await askConfirm({
        title: 'Cancel this lobby?',
        message: 'It will be removed for everyone and its Discord channels deleted right away. This can’t be undone.',
        confirmLabel: 'Cancel lobby', cancelLabel: 'Keep lobby', danger: true,
      });
      if (!ok) return;
      await api('DELETE', base); toast('Lobby cancelled'); location.hash = '#/lobbies';
    });
    document.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', run(() => api('POST', `${base}/approve/${b.dataset.approve}`))));
    document.querySelectorAll('[data-deny]').forEach((b) => b.addEventListener('click', run(() => api('POST', `${base}/deny/${b.dataset.deny}`))));
    document.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', run(async () => { if (!await askConfirm({ title: 'Remove this person?', message: 'They will be taken out of the lobby and lose access to its Discord channels.', confirmLabel: 'Remove', danger: true })) return; return api('POST', `${base}/kick/${b.dataset.kick}`); })));
    document.querySelectorAll('[data-signup]').forEach((b) => b.addEventListener('click', run(() => withServerCheck(async () => {
      const r = await api('POST', `${base}/signup/${b.dataset.signup}`);
      toast("You're signed up for that date!");
      l = r.lobby; render();
      return r;
    }))));
    document.querySelectorAll('[data-withdraw]').forEach((b) => b.addEventListener('click', run(() => api('POST', `${base}/withdraw/${b.dataset.withdraw}`))));
    document.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', run(async () => {
      const ok = await askConfirm({
        title: 'Skip this date?',
        message: 'It will be cancelled for everyone, and its Discord channels (if any) are deleted now. You can restore the date later.',
        confirmLabel: 'Skip date', danger: true,
      });
      if (!ok) return;
      return api('POST', `${base}/skip/${b.dataset.skip}`);
    })));
    document.querySelectorAll('[data-unskip]').forEach((b) => b.addEventListener('click', run(() => api('POST', `${base}/unskip/${b.dataset.unskip}`))));
    document.querySelectorAll('[data-uninvite]').forEach((b) => b.addEventListener('click', run(() => api('POST', `${base}/uninvite/${b.dataset.uninvite}`))));
    const codef = document.getElementById('codef');
    codef?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = new FormData(codef).get('code');
      try {
        await withServerCheck(async () => { const r = await api('POST', `${base}/join`, { code }); l = r.lobby; toast('Joined!'); render(); return r; });
      } catch (err) { toast(err.message, true); }
    });
    const inv = document.getElementById('inv');
    if (inv) {
      const picker = userPicker(inv, { exclude: [...l.members.map((u) => u.id), ...(l.invited || []).map((u) => u.id)] });
      on('#send-inv', async () => {
        const ids = picker.get().map((u) => u.id);
        if (!ids.length) { toast('Pick at least one creator', true); return; }
        const r = await api('POST', `${base}/invite`, { userIds: ids }); toast('Invites sent'); return r;
      });
    }
  }
  render();
}

async function viewInbox() {
  if (!state.me) return requireLogin();
  const d = await api('GET', '/inbox');
  const section = (title, items, empty) => `<div class="card"><h2>${title}</h2>${items.length ? items.join('') : `<p class="dim" style="margin:0">${empty}</p>`}</div>`;
  $app.innerHTML = `
    <div class="page-head"><div><h1>Inbox</h1><p>Requests and invites waiting on you.</p></div></div>
    ${section('Join requests for your lobbies', d.approvals.flatMap((a) => a.requests.map((u) => `<div class="inbox-item"><div>${userLine(u, 32)}<div class="hint" style="margin-top:4px">wants to join <a href="#/lobbies/${esc(a.lobby.id)}">${esc(a.lobby.title)}</a></div></div><div class="row"><button class="btn primary sm" data-approve="${esc(a.lobby.id)}|${esc(u.id)}">Approve</button><button class="btn ghost sm" data-deny="${esc(a.lobby.id)}|${esc(u.id)}">Deny</button></div></div>`)), 'No pending requests.')}
    ${section('Lobby invites', d.invites.map((l) => `<div class="inbox-item"><div><a href="#/lobbies/${esc(l.id)}"><strong>${esc(l.title)}</strong></a><div class="hint">from ${esc(l.host?.displayName)} · ${l.memberCount}/${l.maxSlots} · ${l.scheduledAt ? esc(fmtDate(l.scheduledAt)) : 'anytime'}</div></div><a class="btn primary sm" href="#/lobbies/${esc(l.id)}">View &amp; join</a></div>`), 'No invites right now.')}
    ${section('Friend requests', d.friendRequests.map((u) => `<div class="inbox-item">${userLine(u, 32)}<div class="row"><button class="btn primary sm" data-faccept="${esc(u.id)}">Accept</button><button class="btn ghost sm" data-fdecline="${esc(u.id)}">Decline</button></div></div>`), 'No friend requests.')}
    ${section('Tagged in collabs', d.tags.map((c) => `<div class="inbox-item"><div><strong>${esc(c.title)}</strong><div class="hint">${esc(c.owner?.displayName)} says you were in this · <a href="${esc(c.url)}" target="_blank" rel="noopener">watch</a></div></div><div class="row"><button class="btn primary sm" data-confirm="${esc(c.id)}">Yes, that's me</button><button class="btn ghost sm" data-untag="${esc(c.id)}">Remove tag</button></div></div>`), 'Nothing to confirm.')}`;
  const bind = (attr, fn) => $app.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', act(async () => { await fn(b.dataset[attr.replace(/-./g, (m) => m[1].toUpperCase())]); route(); })));
  bind('approve', (v) => { const [lid, uid] = v.split('|'); return api('POST', `/lobbies/${lid}/approve/${uid}`); });
  bind('deny', (v) => { const [lid, uid] = v.split('|'); return api('POST', `/lobbies/${lid}/deny/${uid}`); });
  bind('faccept', (id) => api('POST', `/friends/${id}/accept`));
  bind('fdecline', (id) => api('DELETE', `/friends/${id}`));
  bind('confirm', (id) => api('POST', `/clips/${id}/confirm`));
  bind('untag', (id) => api('POST', `/clips/${id}/untag`));
}

async function viewFriends() {
  if (!state.me) return requireLogin();
  const d = await api('GET', '/friends');
  $app.innerHTML = `
    <div class="page-head"><div><h1>Friends</h1><p>Friends can see and join your Friends-only lobbies.</p></div><a class="btn" href="#/creators">Find creators</a></div>
    ${d.incoming.length ? `<div class="card"><h2>Requests</h2>${d.incoming.map((u) => `<div class="inbox-item">${userLine(u, 32)}<div class="row"><button class="btn primary sm" data-accept="${esc(u.id)}">Accept</button><button class="btn ghost sm" data-remove="${esc(u.id)}">Decline</button></div></div>`).join('')}</div>` : ''}
    <div class="card"><h2>Friends (${d.friends.length})</h2>${d.friends.length ? d.friends.map((u) => `<div class="inbox-item">${userLine(u, 32)}<button class="btn ghost sm" data-remove="${esc(u.id)}">Remove</button></div>`).join('') : '<p class="dim" style="margin:0">No friends yet — find creators and send a request.</p>'}</div>
    ${d.outgoing.length ? `<div class="card"><h2>Sent requests</h2>${d.outgoing.map((u) => `<div class="inbox-item">${userLine(u, 32)}<button class="btn ghost sm" data-remove="${esc(u.id)}">Cancel</button></div>`).join('')}</div>` : ''}`;
  $app.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', act(async () => { await api('POST', `/friends/${b.dataset.accept}/accept`); route(); })));
  $app.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', act(async () => { await api('DELETE', `/friends/${b.dataset.remove}`); route(); })));
}

// ---------- router ----------

let currentRoute = '';
async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const seg = path.split('/').filter(Boolean);
  currentRoute = seg[0] || '';
  renderNav(currentRoute);
  document.getElementById('modal-root').innerHTML = '';

  // New accounts must finish their profile first.
  if (state.me && !state.me.onboarded && !(seg[0] === 'me' && seg[1] === 'edit')) {
    location.hash = '#/me/edit?welcome=1';
    return;
  }

  const joined = params.get('joined_server');
  if (joined) {
    toast(joined === '1' ? "You're in the Create and Connect server — now hit Join!" : "We couldn't add you to the Discord server automatically. Try again or ask the host for an invite.", joined !== '1');
    params.delete('joined_server');
    history.replaceState(null, '', `#${path}${params.size ? `?${params}` : ''}`);
  }

  $app.innerHTML = '<div class="loading">Loading…</div>';
  window.scrollTo(0, 0);
  try {
    if (!seg.length) await viewHome(params);
    else if (seg[0] === 'lobbies' && !seg[1]) await viewLobbies(params);
    else if (seg[0] === 'lobbies' && seg[1] === 'new') await viewLobbyForm(null);
    else if (seg[0] === 'lobbies' && seg[2] === 'edit') await viewLobbyForm(seg[1]);
    else if (seg[0] === 'lobbies') await viewLobby(seg[1]);
    else if (seg[0] === 'creators') await viewCreators(params);
    else if (seg[0] === 'u' && seg[1]) await viewProfile(seg[1]);
    else if (seg[0] === 'me' && seg[1] === 'edit') await viewEditProfile(params);
    else if (seg[0] === 'inbox') await viewInbox();
    else if (seg[0] === 'friends') await viewFriends();
    else $app.innerHTML = '<div class="empty"><h2>Page not found</h2><a href="#/">Go home</a></div>';
  } catch (e) {
    $app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a class="btn" href="#/">Go home</a></div>`;
  }
  if (state.me) refreshInboxCount().then(() => renderNav(currentRoute));
}

async function boot() {
  try {
    const d = await api('GET', '/me');
    state.me = d.user;
    state.config = d.config;
    if (state.me) state.accounts = (await api('GET', '/accounts')).accounts;
  } catch {
    $app.innerHTML = '<div class="empty"><h2>Can\'t reach the server</h2><p>The API isn\'t responding. If you\'re running locally, use <code>netlify dev</code> or <code>npm run dev:local</code>.</p></div>';
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  try {
    const msg = sessionStorage.getItem('cc_toast');
    if (msg) { sessionStorage.removeItem('cc_toast'); toast(msg); }
  } catch { /* storage unavailable */ }
}

boot();
