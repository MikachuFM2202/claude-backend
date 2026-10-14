// Clawd Mifflin: a 3D campus where Claude Code's sessions, tools, plugins, MCP servers and memory work as
// characters. This file: the password gate, state (local server, password relay, sealed demo), HUD, loop.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  $, rand, pick, clamp, now, renderer, labels, scene, camera, controls, maxDpr, loadKit, buildCampus, layout, screens,
  applyDayNight, mytHours, timeCtl, tv, eom, blocked, cellOf,
} from './world.js';
import { ctx, agents, colorOf, vendorColor, addAgent, hireWL, syncCrowd, updateFlights, updatePingPong } from './people.js';
import {
  sound, setSound, alerts, setAlerts, alert, showContext, hideContexts, deliveries, replay, startReplay, stopReplay,
  drawDundies, dundieCeremony, tickExtras, showBadge, showBuilds, showPayroll, showHeat, openReport, updateWeather, kl, modelName, modeName,
  drill, fireDrill, recordCanvas, initLab, syncBranches, sparkline, sfx,
} from './extras.js';

// ------------------------------------------------------------------ camera views
const VIEWS = {
  overview: [[14, 60, 76], [8, 0, 2]],
  boss: [[-10.5, 9, 16], [-16.5, 0, 8]],
  open: [[4, 13, 15], [-2.5, 0, 1.5]],
  mcp: [[24, 20, 16], [14, 0, -2]],
  break: [[-7, 11, 3], [-13.5, 0, -8.5]],
  hr: [[8, 9, 0], [3, 0, -9.5]],
  archive: [[-1, 8, -1], [-4, 0, -9.5]],
  wl: [[54, 24, 26], [46, 0, -1]],
  wlhr: [[58, 14, 13], [58, 0, -1]],
  term: [[25.5, 10, 17], [25.5, 0, 5]],
  lab: [[-31, 9, 15], [-37, 0, 4]],
  branch: [[25.5, 14, 19], [25.5, 3.4, 5]],
  rec: [[-20, 16, 9], [-27, 0, -4.5]],
  fair: [[-27, 11, 19], [-27, 0, 8]],
  city: [[0, 1.6, -9], [14, 24, -80]],
};
let camTween = null;
// narrower windows need the camera further back to fit the same shot
const farFor = () => clamp(1.75 / (innerWidth / innerHeight), 1, 2.3);
function view(name) {
  const [p, t] = VIEWS[name];
  const far = farFor();
  const to = new THREE.Vector3(...p).sub(new THREE.Vector3(...t)).multiplyScalar(far).add(new THREE.Vector3(...t));
  camTween = { from: camera.position.clone(), fromT: controls.target.clone(), to, toT: new THREE.Vector3(...t), t: 0 };
  ctx.selected = null;
  document.querySelectorAll('.dock [data-zone]').forEach((b) => b.classList.toggle('on', b.dataset.zone === name));
}
camera.position.set(...VIEWS.overview[0]).sub(new THREE.Vector3(...VIEWS.overview[1])).multiplyScalar(farFor()).add(new THREE.Vector3(...VIEWS.overview[1]));
// keep the cards clear of the dock, however many rows it wraps to
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--dock-h', `${Math.ceil(e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight)}px`)).observe(document.querySelector('.dock'));
controls.target.set(...VIEWS.overview[1]);

// ------------------------------------------------------------------ HUD
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
function fmtLeft(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  const at = new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `resets in ${h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`} (${at})`;
}
function renderUsage(u) {
  for (const k of ['session', 'weekly']) {
    const v = u?.[k], pct = v?.pct;
    $(`u-${k}`).textContent = pct == null ? 'n/a' : `${Math.round(pct)}%`;
    const bar = $(`b-${k}`);
    bar.style.width = `${clamp(pct ?? 0, 0, 100)}%`;
    bar.className = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
    $(`r-${k}`).textContent = ctx.live ? fmtLeft(v?.resetsAt) : u?.at ? `as of ${new Date(u.at).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  }
  $('u-src').textContent = !u ? '' : u.error && !u.session ? `unavailable: ${u.error}` : paused ? 'paused: last numbers' : ctx.live ? 'live from your Claude plan' : 'snapshot';
  drawTV(u);
}
function drawTV(u) {
  const g = tv.canvas.getContext('2d'), W = 512, H = 288;
  g.setTransform(tv.canvas.width / W, 0, 0, tv.canvas.height / H, 0, 0);
  g.fillStyle = '#10131a'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#d97757'; g.font = 'bold 26px system-ui'; g.fillText('CLAUDE USAGE', 24, 44);
  g.fillStyle = '#8a93a6'; g.font = '16px system-ui'; g.fillText(paused ? 'PAUSED' : ctx.live ? 'LIVE' : 'DEMO', W - 84, 42);
  const row = (y, label, v) => {
    const pct = v?.pct ?? 0;
    g.fillStyle = '#e6e9ef'; g.font = '20px system-ui'; g.fillText(label, 24, y);
    g.textAlign = 'right'; g.fillText(v ? `${Math.round(pct)}%` : 'n/a', W - 24, y); g.textAlign = 'left';
    g.fillStyle = '#262b36'; g.fillRect(24, y + 12, W - 48, 22);
    g.fillStyle = pct >= 90 ? '#d6453d' : pct >= 70 ? '#e2a33b' : '#d97757'; g.fillRect(24, y + 12, ((W - 48) * clamp(pct, 0, 100)) / 100, 22);
    g.fillStyle = '#8a93a6'; g.font = '14px system-ui'; g.fillText(ctx.live ? fmtLeft(v?.resetsAt) : 'snapshot', 24, y + 54);
  };
  row(96, 'Session (5h)', u?.session);
  row(190, 'Weekly', u?.weekly);
  const busy = [...agents.values()].filter((a) => a.working).length;
  g.fillStyle = '#7ee787'; g.font = '15px system-ui'; g.fillText(`${busy} at work`, 24, 274);
  tv.tex.needsUpdate = true;
}
function drawEOM() {
  const g = eom.canvas.getContext('2d');
  g.fillStyle = '#fbf6ec'; g.fillRect(0, 0, 256, 320);
  g.fillStyle = '#d97757'; g.fillRect(0, 0, 256, 54);
  g.fillStyle = '#fff'; g.font = 'bold 20px system-ui'; g.textAlign = 'center';
  g.fillText('EMPLOYEE OF', 128, 24); g.fillText('THE MONTH', 128, 46);
  const top = Object.entries(ctx.state?.counts || {}).filter(([id]) => id !== 'claude').sort((a, b) => b[1] - a[1]);
  const star = top[0] && agents.get(top[0][0]);
  g.fillStyle = star ? colorOf(star.def) : '#bbb';
  g.fillRect(88, 76, 80, 56); g.fillRect(74, 96, 14, 14); g.fillRect(168, 96, 14, 14);
  for (const x of [96, 116, 136, 156]) g.fillRect(x - 4, 132, 9, 22);
  g.fillStyle = '#111'; g.fillRect(108, 90, 8, 16); g.fillRect(140, 90, 8, 16);
  g.fillStyle = '#2a2420'; g.font = 'bold 22px system-ui';
  g.fillText(star ? star.def.name : 'nobody yet', 128, 186);
  g.font = '15px system-ui'; g.fillStyle = '#7a6f66';
  g.fillText(star ? `${top[0][1]} calls today` : ctx.live ? 'no calls today' : 'demo', 128, 208);
  g.textAlign = 'left'; g.font = '13px system-ui';
  top.slice(1, 5).forEach(([id, n], k) => { const a = agents.get(id); g.fillStyle = '#2a2420'; g.fillText(`${k + 2}. ${a?.def.name || id}`, 22, 238 + k * 19); g.textAlign = 'right'; g.fillText(n, 234, 238 + k * 19); g.textAlign = 'left'; });
  eom.tex.needsUpdate = true;
}
function renderFeed(events) {
  $('feed').replaceChildren(...events.slice(0, 30).map((e) => {
    const li = document.createElement('li');
    const a = agents.get(e.char);
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = e.error ? '#E5484D' : a ? colorOf(a.def) : '#999';
    const who = document.createElement('span'); who.className = 'who'; who.textContent = a?.def.name || e.char;
    const what = document.createElement('span'); what.className = 'what'; what.textContent = (e.error ? '✗ ' : '') + e.tool;
    const time = document.createElement('time'); time.textContent = ago(e.t);
    li.append(dot, who, what, time);
    if (e.error && e.detail) li.title = e.detail;
    li.onclick = () => { focusFail = e.error ? e.id : null; if (a) select(a); };
    return li;
  }));
}
const swatch = (color) => { const i = document.createElement('i'); i.className = 'swatch'; i.style.background = color; return i; };
let cabinetsLabelled = '';
function labelCabinets(memory) {
  const key = JSON.stringify(memory || []);
  if (!memory || key === cabinetsLabelled) return;
  cabinetsLabelled = key;
  layout.cabinetSigns?.forEach((o) => o.removeFromParent());
  layout.cabinetSigns = memory.slice(0, layout.cabinets.length).map((m, k) => {
    const el = document.createElement('div');
    el.className = 'sign';
    el.textContent = `${m.project.replace(/^Project-Pipeline-/, '').slice(0, 22)} · ${m.files.length}`;
    const o = new CSS2DObject(el);
    o.position.set(layout.cabinets[k], 1.6, -12.2);
    scene.add(o);
    return o;
  });
}
function renderLegend() {
  const used = new Map();
  for (const a of agents.values()) {
    if (a.def.kind === 'candidate' || a.def.kind === 'wlcand') continue;
    const label = ctx.cast.vendors[a.def.vendor]?.label || a.def.vendor;
    if (![...used.values()].includes(label)) used.set(a.def.vendor, label);
  }
  $('legend').replaceChildren(...[...used].map(([v, label]) => {
    const s = document.createElement('span');
    s.append(swatch(vendorColor(v)), v === 'anthropic' ? 'Anthropic (Claude family)' : label);
    return s;
  }));
}
function renderStats() {
  const all = [...agents.values()].filter((a) => !['candidate', 'wlcand'].includes(a.def.kind));
  const busy = all.filter((a) => a.working).length;
  const sess = ctx.state?.activeSessions ?? 0;
  $('stats').textContent = `${all.length} staff · ${busy} working${ctx.live && !paused ? ` · ${sess} active session${sess === 1 ? '' : 's'}` : ''}`;
}
let focusFail = null;
function prosCons(d) {
  const pc = document.createElement('div'); pc.className = 'proscons';
  for (const [cls, list] of [['pro', d.pros || []], ['con', d.cons || []]]) for (const t of list) { const r = document.createElement('div'); r.className = cls; r.textContent = t; pc.append(r); }
  return pc;
}
const KIND = { branch: 'Claude Code session on another Mac', fair: 'Candidate (careers fair)', mcp: 'MCP server', core: 'Built-in tool', plugin: 'Plugin', skill: 'Skill', boss: 'Main agent', session: 'Claude Code session', intern: 'Subagent (intern)', archive: 'Memory', reception: 'Hooks', hr: 'HR', candidate: 'Candidate (this week)' };
function select(a) {
  ctx.selected = a;
  camTween = null;
  const d = a.def, el = $('panel-body');
  const status = a.working ? `working: ${a.tool}` : a.disabled ? 'disabled in settings' : (a.task?.kind || 'idle').replace('desk', 'at desk').replace('sleep', 'napping').replace(/^wait$/, 'waiting for you').replace('dundie', 'collecting a Dundie');
  const kind = d.kind === 'wl' ? `${ctx.hq?.name} feature` : d.kind === 'wlcand' ? (d.room?.startsWith('fair') ? KIND.fair : `Candidate for ${ctx.hq?.name}`) : KIND[d.kind] || d.kind;
  const rows = [['Status', status], ['Kind', kind], ['Company', ctx.cast.vendors[d.vendor]?.label || d.author || d.vendor]];
  if (d.author) rows.push(['Author', d.author]);
  if (d.category) rows.push(['Category', d.category]);
  if (d.version) rows.push(['Version', d.version]);
  if (d.source) rows.push(['Source', d.source]);
  if (d.needsAuth) rows.push(['Auth', 'needs sign-in (/mcp)']);
  if (d.mcp?.length) rows.push(['MCP', d.mcp.join(', ')]);
  if (d.skills) rows.push(['Skills', d.skills]);
  if (d.hooks?.length) rows.push(['Hooks', d.hooks.map((h) => `${h.event} ×${h.count}`).join(', ')]);
  if (d.memory) rows.push(['Memory', d.memory.map((m) => `${m.project}: ${m.files.length}`).join('\n')]);
  if (d.paths) rows.push(['Files', d.paths.join('\n')]);
  if (d.session) rows.push(['Model', [modelName(d.session.model), d.session.effort && `${d.session.effort} effort`].filter(Boolean).join(', ') || 'unknown'], ['Mode', modeName(d.session.mode) || 'unknown']);
  if (d.heat) rows.push(['This week', `${d.heat} lines changed`]);
  if (d.ctx) rows.push(['Context', `${Math.round(d.ctx.tokens / 1000)}k of ${d.ctx.max >= 1e6 ? '1M' : '200k'} tokens${d.ctx.compactedAt ? `\ncompacted ${ago(d.ctx.compactedAt)} ago` : ''}`]);
  if (d.waiting) rows.push(['Waiting', { permission: 'for your OK on a permission prompt', input: 'for your input', reply: 'for your next message' }[d.waiting]]);
  // a 30-day career: calls per day, the best day, Dundies won
  const career = ctx.state?.careers?.chars?.[d.id];
  if (career?.some((n) => n)) {
    const best = career.indexOf(Math.max(...career)), day = new Date(ctx.state.careers.from + best * 86400e3 + 12 * 3600e3);
    rows.push(['30 days', `${career.reduce((a, b) => a + b, 0)} calls · best ${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} (${career[best]})`]);
  }
  const wins = ctx.state?.careers?.wins?.[d.id];
  if (wins) rows.push(['Dundies', `🏆 × ${wins}`]);
  const h3 = document.createElement('h3');
  h3.append(swatch(colorOf(d)), d.name || d.id);
  const title = document.createElement('div'); title.className = 'title'; title.textContent = d.title || '';
  const p = document.createElement('p'); p.textContent = d.desc || d.bio || '';
  const dl = document.createElement('dl');
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dd.style.whiteSpace = 'pre-line'; dl.append(dt, dd); }
  el.replaceChildren(h3, title, p, dl);
  if (career?.some((n) => n)) { const sp = document.createElement('div'); sp.className = 'spark'; sp.innerHTML = sparkline(career); el.append(sp); }
  // a suggestion's pros and cons
  if (d.pros?.length || d.cons?.length) el.append(prosCons(d));
  // where to get it: the official page or repo, to open or copy and share
  for (const [label, link] of [['Get it', d.url], ['Website', d.homepage !== d.url && d.homepage]]) {
    if (!safeUrl(link)) continue;
    const r = document.createElement('div'); r.className = 'link';
    const b = document.createElement('button'); b.textContent = 'Copy'; b.title = 'Copy the link to share it';
    b.onclick = () => navigator.clipboard?.writeText(link).then(() => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); });
    r.append(`${label}: `, linkTo(link, link.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')), b);
    el.append(r);
  }
  if (d.why?.length) { const w = document.createElement('p'); w.className = 'muted'; w.textContent = `Picked for your ${d.why.join(', ')} work (week ${ctx.state?.hr?.week || ''}).`; el.append(w); }
  if (d.install) { const c = document.createElement('code'); c.textContent = d.install; el.append(c); }
  if (d.plugins?.length) {
    const h = document.createElement('h2'); h.textContent = 'Could use';
    el.append(h);
    for (const pl of d.plugins) {
      const r = document.createElement('div'); r.className = 'rec';
      const b = document.createElement('b'); b.append(safeUrl(pl.url) ? linkTo(pl.url, pl.name) : pl.name);
      const c = document.createElement('code'); c.textContent = pl.install;
      r.append(b, ` ${pl.description.slice(0, 110)}…`, prosCons(pl), c); el.append(r);
    }
  }
  const mine = (ctx.state?.events || []).filter((e) => e.char === d.id).slice(0, 6);
  if (mine.length) {
    const h = document.createElement('h2'); h.textContent = 'Recent'; el.append(h);
    for (const e of mine) {
      const r = document.createElement('div'); r.textContent = `${ago(e.t)} · ${e.error ? '✗ ' : ''}${e.tool}`; el.append(r);
      // a failure says why: the start of the error, and the command or file it was working on
      if (e.error && (e.detail || e.input)) {
        const pre = document.createElement('pre'); pre.className = 'err';
        pre.textContent = [e.input && `$ ${e.input}`, e.detail].filter(Boolean).join('\n');
        if (e.id && e.id === focusFail) pre.classList.add('focus');
        el.append(pre);
      }
    }
  }
  $('panel').hidden = false;
}
ctx.onSelect = select;
const safeUrl = (u) => typeof u === 'string' && /^https:\/\//.test(u);
function linkTo(href, text) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = text; return a; }

// ------------------------------------------------------------------ Spotify: controls on the Mac's own page, now playing everywhere
const radio = (() => {
  const el = document.createElement('div');
  el.className = 'sign radio';
  const o = new CSS2DObject(el);
  o.position.set(-18.4, 2.5, -8.2); // over the break room TV
  o.visible = false;
  scene.add(o);
  return { el, o };
})();
let musicNow = null;
function renderMusic(m) {
  musicNow = m;
  ctx.music = !!m?.playing;
  radio.o.visible = !!m?.playing;
  if (m?.playing) radio.el.textContent = `♪ ${m.track} · ${m.artist}`;
  $('spotify').classList.toggle('playing', !!m?.playing);
  const t = $('m-track');
  t.replaceChildren(!m ? 'Live updates are off' : !m.running ? 'Spotify is closed' : m.track ? (safeUrl(m.url) ? linkTo(m.url, `${m.track} · ${m.artist}`) : `${m.track} · ${m.artist}`) : 'Nothing queued');
  $('m-state').textContent = m?.running ? (m.playing ? 'playing on the Mac' : 'paused on the Mac') : '';
  const local = source === 'local';
  document.querySelectorAll('#music [data-cmd]').forEach((b) => (b.disabled = !local));
  $('m-note').hidden = local;
}
document.querySelectorAll('#music [data-cmd]').forEach((b) => (b.onclick = async () => {
  const r = await fetch('api/spotify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: b.dataset.cmd }) }).catch(() => null);
  if (r?.ok) renderMusic(await r.json());
}));
$('spotify').onclick = () => { $('music').hidden = !$('music').hidden; if (!$('music').hidden) renderMusic(musicNow); };
$('music-close').onclick = () => ($('music').hidden = true);
$('panel-close').onclick = () => { $('panel').hidden = true; ctx.selected = null; };

// ------------------------------------------------------------------ state: local server, password relay, or the sealed demo
// The public site shows nothing until a password is entered at the gate. The demo password opens the demo, whose
// data (state.enc) is sealed with it (PBKDF2 + AES-GCM). The live password opens the live view through the relay,
// and only that brings the private HQ along. The Mac's own page needs neither.
const RELAY = 'https://clawd-mifflin.aisymikhailkmb.workers.dev/state';
const PASS_KEY = 'clawd-mifflin-pass', DEMO_KEY = 'clawd-mifflin-demo', PAUSE_KEY = 'clawd-mifflin-paused';
async function unseal(box, password) {
  try {
    const enc = new TextEncoder(), raw = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: raw(box.salt), iterations: box.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw(box.iv) }, key, raw(box.data))));
  } catch { return null; } // wrong password
}
let sealed = null;
const openDemo = async (password) => {
  sealed ||= await fetch('state.enc', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return sealed && password ? unseal(sealed, password) : null;
};
const relayCheck = (password) => fetch(RELAY, { headers: { authorization: `Bearer ${password}` }, cache: 'no-store' }).then((r) => r.status).catch(() => 0);
/** The gate: wait until a password opens the live view or the demo, and remember which. */
function gate() {
  $('loading-text').hidden = true;
  $('gate').hidden = false;
  $('gate-pass').focus();
  return new Promise((done) => {
    $('gate').onsubmit = async (e) => {
      e.preventDefault();
      const v = $('gate-pass').value.trim();
      if (!v) return;
      $('gate-msg').textContent = 'Checking…';
      // the demo password is checked here in the browser; only anything else goes to the relay
      if (await openDemo(v)) { store.set(DEMO_KEY, v); return done(); }
      const status = await relayCheck(v);
      if (status && status !== 401) { store.set(PASS_KEY, v); return done(); }
      $('gate-msg').textContent = status ? 'Wrong password' : 'Wrong password (or offline)';
      $('gate-pass').select();
    };
  }).then(() => { $('gate').hidden = true; $('loading-text').hidden = false; });
}
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let source = null, offline = false, paused = store.get(PAUSE_KEY) === '1';
async function fetchState(fresh = false) {
  // only the Mac's own page has the local API: elsewhere (GitHub Pages) don't even ask
  if ((source === null || source === 'local') && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    try {
      const r = await fetch(fresh ? 'api/state?fresh=1' : 'api/state', { cache: 'no-store' });
      if (r.ok) { source = 'local'; ctx.live = true; offline = false; return await r.json(); }
    } catch { /* not served by the local server */ }
  }
  const pass = store.get(PASS_KEY);
  if (pass) {
    try {
      const r = await fetch(RELAY, { headers: { authorization: `Bearer ${pass}` }, cache: 'no-store' });
      if (r.status === 401) {
        store.set(PASS_KEY, null);
        if (source === 'relay') location.reload(); // the live password changed: rebuild as the demo, without the HQ
        $('unlock-msg').textContent = 'Wrong password';
      }
      else if (r.ok) {
        const s = await r.json();
        source = 'relay'; ctx.live = true;
        offline = !s.paused && Date.now() - s.now > 3 * 60 * 1000; // the Mac pushes at least once a minute
        return s;
      } else if (r.status === 404) { $('unlock-msg').textContent = 'No live data yet: is the Mac server running?'; }
    } catch { if (source === 'relay' && ctx.state) { offline = true; return ctx.state; } }
  }
  const demoState = await openDemo(store.get(DEMO_KEY));
  if (!demoState) return null; // nothing opens: back to the gate
  source = 'demo'; ctx.live = false; offline = false;
  return demoState;
}

const DEMO_TOOLS = {
  bash: ['bash: npm test', 'bash: git status', 'bash: expo export'], reader: ['Read index.ts', 'Grep handler', 'Glob **/*.ts'],
  editor: ['Edit index.ts', 'Write README.md'], web: ['WebSearch expo sdk', 'WebFetch docs'], tasks: ['TaskCreate', 'TaskUpdate'],
  memory: ['Write memory'], hooks: ['UserPromptSubmit', 'SessionStart:startup'], playwright: ['browser_navigate', 'browser_click', 'browser_take_screenshot'],
  context7: ['query-docs', 'resolve-library-id'], expo: ['eas build', 'skill expo:expo-router'], 'claude-in-chrome': ['navigate', 'read_page', 'computer'],
  gmail: ['search_threads'], 'google-drive': ['search_files'], caveman: ['skill caveman:caveman-commit'], ponytail: ['skill ponytail:ponytail-review'],
};
const demo = { until: new Map(), events: [], subs: [], fails: [] };
function demoTick() {
  const t = Date.now();
  const pool = [...agents.values()].filter((a) => !a.disabled && !['candidate', 'wlcand', 'boss', 'session', 'intern', 'hr'].includes(a.def.kind));
  if (Math.random() < 0.7) {
    const a = Math.random() < 0.6 ? pick(pool.filter((x) => DEMO_TOOLS[x.id])) : pick(pool);
    if (a && !demo.until.has(a.id)) {
      const tool = pick(DEMO_TOOLS[a.id] || ['working']);
      demo.until.set(a.id, { until: t + rand(5000, 22000), tool, error: Math.random() < 0.12 });
      demo.events.unshift({ t, char: a.id, tool });
      demo.events = demo.events.slice(0, 40);
    }
  }
  if (Math.random() < 0.06 && demo.subs.length < 2) demo.subs.push({ id: `demo${t}`, type: pick(['Explore', 'Plan', 'general-purpose']), desc: pick(['find the auth flow', 'plan the refactor', 'read the docs']), until: t + rand(15000, 40000) });
  demo.subs = demo.subs.filter((x) => x.until > t);
  const status = {};
  for (const [id, v] of demo.until) {
    if (t > v.until) { demo.until.delete(id); if (v.error) demo.fails.push({ id: `f${id}${v.until}`, char: id, tool: v.tool, t }); continue; }
    status[id] = { working: true, tool: v.tool };
  }
  demo.fails = demo.fails.filter((f) => t - f.t < 60000);
  if (Object.keys(status).length || demo.subs.length) status.claude = { working: true, tool: pick(['thinking', 'planning', 'answering']) };
  return { status, events: demo.events, subagents: demo.subs, failures: demo.fails, sessions: [] };
}

const seenFailures = new Set(), lastWait = new Map(), seenClash = new Set();
const CLASH_LINES = [["that's MY file!", 'I was here first'], ['merge conflict incoming', 'you overwrote my edit!'], ['fine, you take it', 'git stash, then talk']];
/** Two sessions edited the same file: their Claudes meet in the hallway and argue it out. */
function clash(c, sessionAgent) {
  const who = c.sessions.map((sid) => sessionAgent.get(sid)).filter(Boolean).slice(0, 3);
  if (who.length < 2) return;
  who.forEach((a, i) => {
    a.setWork(false);
    a.holdUntil = now() + 10;
    a.goTo(layout.clashSpots[i], 'clash', 10, true);
    CLASH_LINES.forEach((pair, k) => setTimeout(() => a.say(pair[i % 2], 2.6, 'err'), 1800 + k * 2700 + i * 1300));
  });
  sfx('buzz', who[0].root.position);
  alert('Same-file clash', `Two sessions are editing ${c.file}. One will overwrite the other.`);
}
let firstState = true;
const WAIT_ALERT = { permission: 'needs your OK on a permission prompt', input: 'is waiting for your input', reply: 'finished and is waiting for you' };
function applyState(s) {
  ctx.state = s;
  const quiet = paused || offline || s.paused;
  const st = !ctx.live ? (paused ? { ...s, status: {}, subagents: [], failures: [] } : { ...s, ...demoTick() })
    : quiet ? { ...s, status: {}, subagents: [], failures: [] } : s;
  ctx.state.events = st.events || [];
  const { sessionAgent, boss } = syncCrowd(st);
  const fromFor = (session) => sessionAgent.get(session) || boss;
  // each session's Claude works while that session is busy
  const sessions = st.sessions || [];
  const toolOf = (sid) => Object.values(st.status || {}).find((x) => x.session === sid)?.tool;
  hideContexts();
  let waitIdx = 0, planIdx = 0;
  for (const c of st.clashes || []) {
    if (seenClash.has(c.id)) continue;
    seenClash.add(c.id);
    if (!firstState && !quiet && !replay.on) clash(c, sessionAgent);
  }
  for (const [sid, a] of sessionAgent) {
    const x = sessions.find((y) => y.id === sid);
    a.def.ctx = x?.ctx; a.def.waiting = x?.waiting; a.def.session = x;
    showContext(a, sid, x?.ctx);
    showBadge(a, x);
    if (replay.on || now() < (a.holdUntil || 0)) continue;
    // waiting for you beats busy: a permission prompt leaves the tool call pending; plan mode works at the whiteboard
    const kind = !quiet && x?.waiting;
    if (kind) {
      a.setWork(false);
      a.wait(kind, layout.waitSpots[waitIdx++ % layout.waitSpots.length]);
      if (lastWait.get(sid) !== kind && !firstState) alert(a.def.name, `Claude ${WAIT_ALERT[kind]}`);
    } else if (!quiet && x?.mode === 'plan' && layout.planSpots[planIdx]) {
      a.setWork(false);
      a.wait('plan', layout.planSpots[planIdx++]);
    } else {
      a.wait(null);
      const busy = !quiet && x?.busy;
      a.setWork(!!busy, busy ? toolOf(sid) || 'thinking' : '');
    }
    lastWait.set(sid, kind || null);
  }
  if (!replay.on) {
    if (boss) { const w = st.status?.claude; boss.setWork(!!w?.working, w?.tool); }
    for (const a of agents.values()) {
      if (['candidate', 'wlcand', 'boss', 'session', 'intern'].includes(a.def.kind)) continue;
      const w = st.status?.[a.id];
      a.setWork(!!w?.working && !a.disabled, w?.tool, fromFor(w?.session));
    }
    for (const f of st.failures || []) {
      if (seenFailures.has(f.id)) continue;
      seenFailures.add(f.id);
      agents.get(f.char)?.fail(f.tool);
    }
  }
  if (!quiet) deliveries(st.deliveries);
  for (const [id, url] of Object.entries(s.wlLinks || {})) { const a = agents.get(id); if (a) a.def.url = url; }
  showBuilds(s.builds || []);
  syncBranches(s.branches || [], quiet);
  // fire drill: weekly usage past 80% sounds the alarm once per weekly reset
  const weekly = s.usage?.weekly;
  document.querySelector('.usage').classList.toggle('alarm', (weekly?.pct ?? 0) >= 80);
  if ((weekly?.pct ?? 0) >= 80 && !quiet && store.get('clawd-mifflin-drill') !== String(weekly.resetsAt)) {
    store.set('clawd-mifflin-drill', String(weekly.resetsAt));
    setTimeout(fireDrill, firstState ? 3000 : 0);
  }
  showPayroll(s.payroll || []);
  showHeat(s.heat || {});
  if (!paused) updateWeather();
  $('wx').textContent = kl.text ? `${kl.text}${kl.temp != null ? ` ${Math.round(kl.temp)}°C` : ''}` : '';
  renderMusic(quiet ? null : s.music);
  drawDundies(s.dundies);
  if (ctx.live && !quiet) dundieCeremony(s.dundies);
  firstState = false;
  for (const o of layout.mcpOffices) {
    const a = agents.get(o.seat.owner);
    if (a) o.glow.material.color.set(colorOf(a.def));
    o.glow.material.opacity = a?.working ? 0.28 : 0;
  }
  const mode = $('mode');
  mode.textContent = paused || s.paused ? 'PAUSED' : offline ? `OFFLINE · seen ${ago(s.now)} ago` : ctx.live ? 'LIVE' : 'DEMO';
  mode.className = `pill ${paused || s.paused ? 'paused' : offline || !ctx.live ? 'demo' : 'live'}`;
  mode.title = paused ? 'Live updates are off here. The office keeps going on its own.' : s.paused ? 'Live updates are switched off on the Mac.' : source === 'relay' ? 'Live from the Mac through the Cloudflare relay' : ctx.live ? 'Reading your Claude Code sessions' : 'Snapshot with simulated work. Unlock with the password, or run `node server.mjs` locally.';
  $('unlock').hidden = source !== 'demo';
  $('lock').hidden = source !== 'relay';
  labelCabinets(agents.get('memory')?.def.memory);
  drawEOM();
  renderUsage(s.usage);
  renderFeed(ctx.state.events);
  renderStats();
  renderLegend();
  if (ctx.selected && !$('panel').hidden && agents.has(ctx.selected.id)) select(ctx.selected);
}

let polling = false;
async function poll(fresh = false) {
  if (polling) return;
  polling = true;
  try {
    // paused: no network at all, the office runs on its own; demo: the snapshot is already loaded
    if (paused && !fresh) applyState(ctx.state);
    else applyState((ctx.live || fresh || !ctx.state ? await fetchState(fresh) : ctx.state) || ctx.state);
  } finally { polling = false; }
}

// ------------------------------------------------------------------ controls
// Switching between demo and live rebuilds the page: the HQ is only built when the live state brings it.
$('unlock').onsubmit = async (e) => {
  e.preventDefault();
  const v = $('pass').value.trim();
  if (!v) return;
  $('unlock-msg').textContent = 'Checking…';
  const status = await relayCheck(v);
  if (status === 401 || !status) { $('unlock-msg').textContent = status ? 'Wrong password' : 'Offline?'; return; }
  store.set(PASS_KEY, v);
  location.reload();
};
$('lock').onclick = () => { store.set(PASS_KEY, null); location.reload(); };
$('refresh').onclick = async (e) => {
  const b = e.currentTarget;
  b.classList.add('spin');
  try { await poll(true); } catch { location.reload(); }
  setTimeout(() => b.classList.remove('spin'), 600);
};
// Live switch. Off: this page stops fetching. On the Mac's own page it also stops the Mac pushing to the
// relay and reading the usage numbers, until switched back on.
function setPaused(p) {
  paused = p;
  store.set(PAUSE_KEY, p ? '1' : null);
  $('live').setAttribute('aria-checked', String(!p));
  if (source === 'local') fetch('api/live', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !p }) }).catch(() => {});
  poll(!p);
}
$('live').onclick = () => setPaused(!paused);
$('sound').onclick = () => { setSound(!sound.on); $('sound').setAttribute('aria-checked', String(sound.on)); };
$('sound').setAttribute('aria-checked', String(sound.on));
$('alerts').onclick = async () => { $('alerts').setAttribute('aria-checked', String(await setAlerts(!alerts.on))); };
$('alerts').setAttribute('aria-checked', String(alerts.on));
if (typeof Notification === 'undefined') $('alerts').hidden = true;
$('report-btn').onclick = () => { openReport(ctx.state?.report); $('digest').hidden = source !== 'local'; };
$('digest').onclick = async () => {
  $('digest-msg').textContent = 'Sending…';
  const r = await fetch('api/digest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((x) => x.json()).catch(() => null);
  $('digest-msg').textContent = !r ? 'The Mac server did not answer.' : r.sent ? 'Sent to Telegram.' : `Not sent: ${r.error}`;
};
$('timelapse').onclick = () => {
  if (replay.on) return;
  if (!replayList().length) { $('timelapse').textContent = '⏺ nothing yet today'; setTimeout(() => ($('timelapse').textContent = '⏺ Time-lapse'), 1800); return; }
  const stop = recordCanvas();
  if (!stop) { $('timelapse').textContent = 'not supported here'; return; }
  $('timelapse').textContent = '⏺ Recording…';
  $('timelapse').classList.add('rec-on');
  $('replay').onclick();
  const wait = setInterval(async () => {
    if (replay.on) return;
    clearInterval(wait);
    await stop();
    $('timelapse').textContent = '⏺ Time-lapse';
    $('timelapse').classList.remove('rec-on');
  }, 500);
};
$('report-close').onclick = () => ($('report').hidden = true);
$('report-copy').onclick = () => navigator.clipboard?.writeText($('report').dataset.text || '').then(() => { $('report-copy').textContent = 'Copied'; setTimeout(() => ($('report-copy').textContent = 'Copy as text'), 1500); });
const replayList = () => (ctx.live ? ctx.state?.replay || [] : [...(ctx.state?.events || [])].reverse().map((e) => [e.t, e.char, e.tool, e.error ? 1 : 0]));
$('replay').onclick = () => {
  if (replay.on) return stopReplay();
  const list = replayList();
  if (!list.length) { $('replay').textContent = '▶ nothing yet today'; setTimeout(() => ($('replay').textContent = '▶ Replay'), 1800); return; }
  $('replay').textContent = '■ Stop';
  startReplay(list, () => {
    $('replay').textContent = '▶ Replay';
    timeCtl.override = Number($('time').value);
    $('time').oninput({ target: $('time') });
    poll();
  });
};
$('live').setAttribute('aria-checked', String(!paused));
document.querySelectorAll('.dock [data-zone]').forEach((b) => (b.onclick = () => view(b.dataset.zone)));
$('time').oninput = (e) => {
  timeCtl.override = Number(e.target.value);
  $('time-label').textContent = timeCtl.override < 0 ? 'auto' : `${String(Math.floor(timeCtl.override)).padStart(2, '0')}:${String(Math.round((timeCtl.override % 1) * 60)).padStart(2, '0')}`;
  for (const a of agents.values()) if (!a.working && a.task) a.task.end = 0; // react to the new time of day
};
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects([...agents.values()].map((a) => a.rig), true)[0];
  if (hit?.object.userData.agent) select(hit.object.userData.agent);
});
controls.addEventListener('start', () => { camTween = null; ctx.selected = null; });

// ------------------------------------------------------------------ boot and frame loop
async function boot() {
  ctx.cast = await (await fetch('cast.json')).json();
  const loader = new GLTFLoader();
  const [gltf, kitGltf] = await Promise.all([loader.loadAsync('models/cast.glb'), loader.loadAsync('models/kit.glb')]);
  ctx.gltf = gltf.scene;
  loadKit(kitGltf);
  let first = await fetchState();
  while (!first) { await gate(); first = await fetchState(); }
  ctx.hq = first.hq || null;
  if (ctx.hq) {
    ctx.cast.vendors.hq = { label: ctx.hq.vendorLabel || ctx.hq.name, color: ctx.hq.color };
    for (const z of ['wl', 'wlhr']) document.querySelector(`.dock [data-zone=${z}]`).hidden = false;
    document.querySelector('.dock [data-zone=wl]').textContent = `${ctx.hq.name} HQ`;
    document.querySelector('.dock [data-zone=wlhr]').textContent = `${ctx.hq.short} HR`;
  }
  const chars = first.characters.filter((c) => c.id !== 'generic');
  for (const c of chars) c.kind ||= 'plugin';
  const mcp = chars.filter((c) => c.kind === 'mcp');
  const family = chars.filter((c) => c.kind === 'core' || ((c.kind === 'plugin' || c.kind === 'skill') && c.vendor === 'anthropic')).length;
  buildCampus({
    mcpCount: mcp.length, mcpTints: mcp.map((c) => colorOf(c)), podCount: Math.min(8, Math.ceil((family + 4) / 6)),
    hq: ctx.hq, fair: ctx.cast.fair,
  });
  for (const c of [...chars.filter((c) => c.kind !== 'mcp'), ...mcp]) addAgent(c);
  if (ctx.hq) hireWL();
  if (source === 'local') {
    // the Mac remembers the live switch; follow it
    const l = await fetch('api/live').then((r) => r.json()).catch(() => null);
    if (l) { paused = !l.live; store.set(PAUSE_KEY, paused ? '1' : null); $('live').setAttribute('aria-checked', String(!paused)); }
  }
  applyState(first);
  initLab(source === 'local');
  if (new URLSearchParams(location.search).has('drill')) setTimeout(fireDrill, 2000); // ?drill to preview
  $('loading').classList.add('gone');
  setInterval(poll, 2500);
  // on the Mac's own page, Claude Code's hooks ping the server and the server pings this page straight away
  if (source === 'local' && typeof EventSource !== 'undefined') new EventSource('api/stream').onmessage = () => { if (!paused) poll(); };
}

// quality: drop the pixel ratio when frames run long, raise it back when there is headroom
let fps = 60, dpr = maxDpr, lastDprChange = 0;
function adapt(t) {
  if (t - lastDprChange < 3) return;
  if (fps < 42 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); lastDprChange = t; }
  else if (fps > 58 && dpr < maxDpr) { dpr = Math.min(maxDpr, dpr + 0.25); renderer.setPixelRatio(dpr); lastDprChange = t; }
}
if (location.search.includes('debug')) setInterval(() => console.log('render', JSON.stringify(renderer.info.render), 'fps', fps.toFixed(0), 'dpr', dpr, 'agents', agents.size), 3000);

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
let frameNo = 0;
function frame() {
  requestAnimationFrame(frame);
  const raw = clock.getDelta(), dt = Math.min(raw, 0.05), t = now();
  fps = fps * 0.95 + (1 / Math.max(raw, 1e-3)) * 0.05;
  adapt(t);
  const replayHour = tickExtras(dt, t);
  if (replayHour != null) {
    timeCtl.override = replayHour;
    $('time-label').textContent = `▶ ${String(Math.floor(replayHour)).padStart(2, '0')}:${String(Math.floor((replayHour % 1) * 60)).padStart(2, '0')}`;
  }
  applyDayNight(mytHours());
  for (const a of agents.values()) a.update(dt, t);
  for (const a of [...agents.values()]) if (a.gone) a.dispose();
  // keep walkers from overlapping
  const walkers = [...agents.values()].filter((a) => a.pose === 'walk');
  for (const a of walkers) for (const b of walkers) {
    if (a === b) continue;
    const dx = a.root.position.x - b.root.position.x, dz = a.root.position.z - b.root.position.z, d = Math.hypot(dx, dz);
    if (d > 0 && d < 0.6) {
      const nx = a.root.position.x + (dx / d) * 0.6 * dt, nz = a.root.position.z + (dz / d) * 0.6 * dt;
      if (!blocked(...cellOf(nx, nz))) a.root.position.set(nx, 0, nz);
    }
  }
  updatePingPong(t);
  updateFlights(dt);
  for (const sc of screens) {
    const o = sc.owner;
    sc.mesh.visible = !!(o?.working && o.task?.arrived && o.task.spot === o.home);
    if (sc.mesh.visible) sc.tex.offset.y -= dt * 0.25;
  }
  if (camTween) {
    camTween.t = Math.min(1, camTween.t + dt * 1.2);
    const k = 1 - Math.pow(1 - camTween.t, 3);
    camera.position.lerpVectors(camTween.from, camTween.to, k);
    controls.target.lerpVectors(camTween.fromT, camTween.toT, k);
    if (camTween.t >= 1) camTween = null;
  } else if (ctx.selected) {
    tmp.copy(ctx.selected.root.position);
    const delta = tmp.sub(controls.target).multiplyScalar(Math.min(1, dt * 3));
    controls.target.add(delta);
    camera.position.add(delta);
  }
  // far away: only show who is working; cabinet labels only up close
  const dist = camera.position.distanceTo(controls.target);
  for (const a of agents.values()) a.tagEl.classList.toggle('far', dist > 42 && !a.working && a !== ctx.selected);
  layout.cabinetSigns?.forEach((o) => { o.visible = camera.position.distanceTo(o.position) < 24; });
  controls.update();
  if (++frameNo % 2 === 0) renderer.shadowMap.needsUpdate = true; // moving shadows at half rate
  renderer.render(scene, camera);
  labels.render(scene, camera);
}

boot().then(frame).catch((e) => { $('loading').textContent = `Could not open the office: ${e.message}`; console.error(e); });
