// The extras: sound, desktop alerts, context-window paper stacks and the shredder, the mail cart that
// delivers the HQ's commits, the day replay and the Dundies.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  scene, camera, renderer, M, clamp, now, pick, rand, findPath, nearestFree, cellOf, centre, blocked, layout, dundieBoard, ciBoard, payBoard,
  setWeather, MAIN, REC, branchFloor,
} from './world.js';
import { ctx, agents, colorOf, fly, addAgent } from './people.js';

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ sound: synthesised, no files, off by default
let ac = null, noise = null;
export const sound = { on: store.get('clawd-mifflin-sound') === '1' };
export function setSound(on) {
  sound.on = on;
  store.set('clawd-mifflin-sound', on ? '1' : null);
  if (on) {
    ac ||= new AudioContext();
    ac.resume();
    if (!noise) {
      noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
  }
}
// browsers only start audio after a click: a remembered "on" waits for the first one
if (sound.on) addEventListener('pointerdown', () => setSound(sound.on), { once: true });

function env(gain, t0, attack, hold, release) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.setValueAtTime(gain, t0 + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
  g.connect(ac.destination);
  return g;
}
function tone(type, freq, gain, t0, dur) {
  const o = ac.createOscillator();
  o.type = type; o.frequency.value = freq;
  o.connect(env(gain, t0, 0.005, dur * 0.3, dur * 0.7));
  o.start(t0); o.stop(t0 + dur + 0.05);
}
function hiss(filter, freq, gain, t0, dur, q = 1) {
  const src = ac.createBufferSource();
  src.buffer = noise; src.loop = true;
  const f = ac.createBiquadFilter();
  f.type = filter; f.frequency.value = freq; f.Q.value = q;
  src.connect(f).connect(env(gain, t0, 0.01, dur * 0.5, dur * 0.5));
  src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.05);
}
const SOUNDS = {
  clack: (v, t) => hiss('highpass', 2500, 0.05 * v, t, 0.03),
  tock: (v, t) => tone('sine', 950, 0.12 * v, t, 0.07),
  hiss: (v, t) => hiss('bandpass', 2800, 0.06 * v, t, 1.6, 0.8),
  buzz: (v, t) => tone('square', 110, 0.05 * v, t, 0.3),
  chime: (v, t) => { tone('sine', 880, 0.15 * v, t, 0.35); tone('sine', 1320, 0.12 * v, t + 0.15, 0.5); },
  shred: (v, t) => { for (let k = 0; k < 10; k++) hiss('bandpass', 700 + k * 40, 0.07 * v, t + k * 0.11, 0.1, 2); },
  horn: (v, t) => { tone('square', 440, 0.05 * v, t, 0.14); tone('square', 440, 0.05 * v, t + 0.22, 0.14); },
  fanfare: (v, t) => [523, 659, 784, 1047].forEach((f, k) => tone('triangle', f, 0.1 * v, t + k * 0.12, k === 3 ? 0.6 : 0.15)),
};
/** Play a sound, quieter the further `pos` is from the camera. */
export function sfx(kind, pos = null) {
  if (!sound.on || !ac || ac.state !== 'running') return;
  const v = pos ? clamp(1 - camera.position.distanceTo(pos) / 70, 0, 1) : 1;
  if (v > 0.02) SOUNDS[kind]?.(v, ac.currentTime);
}
ctx.sfx = sfx;
let clackAt = 0;
function ambient(t) {
  if (!sound.on || t < clackAt) return;
  clackAt = t + 0.07 + Math.random() * 0.12;
  const typing = [...agents.values()].filter((a) => a.working && a.task?.arrived && a.task.spot === a.home);
  const a = pick(typing);
  if (a) sfx('clack', a.root.position);
}

// ------------------------------------------------------------------ desktop alerts when a Claude waits for you
export const alerts = { on: store.get('clawd-mifflin-alerts') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted' };
// Phone alerts: with the live view (or on the Mac's page) Alerts also subscribes this browser to Web Push through
// the relay, so the alert arrives with the page closed; on iPhone that needs the Home Screen app.
const RELAY_ORIGIN = 'https://clawd-mifflin.aisymikhailkmb.workers.dev';
const keyBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
async function pushSubscribe(on, source, pass) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!on && !sub) return false;
  if (on && !sub) {
    const { key } = await fetch(`${RELAY_ORIGIN}/push/key`).then((r) => r.json());
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  }
  const body = JSON.stringify({ subscription: sub.toJSON(), on });
  const r = source === 'local'
    ? await fetch('api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    : await fetch(`${RELAY_ORIGIN}/push/subscribe`, { method: 'POST', headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json' }, body });
  if (!r.ok) throw new Error(`the relay said HTTP ${r.status}`);
  if (!on) await sub.unsubscribe();
  return on;
}
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window;
/** Switch alerts; returns { on, push, note } (note: why phone alerts are not on, if they are not). */
export async function setAlerts(on, { source, pass } = {}) {
  if (on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') on = (await Notification.requestPermission()) === 'granted';
  alerts.on = on;
  store.set('clawd-mifflin-alerts', on ? '1' : null);
  let note = '';
  alerts.push = false;
  if (source !== 'local' && source !== 'relay') note = on ? 'Phone alerts need the live view.' : '';
  else if (!pushSupported()) note = on ? 'Phone alerts on iPhone: Add to Home Screen, open the app, then switch Alerts on there.' : '';
  else {
    try { alerts.push = await pushSubscribe(on, source, pass); } catch (e) { note = `Phone alerts are not on: ${e.message}`; }
  }
  return { on, push: alerts.push, note };
}
export function alert(title, body, { pushed = false } = {}) {
  sfx('chime');
  if (pushed && alerts.push) return; // the Mac sends this one as a push alert already
  if (!alerts.on || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: title, icon: 'icons/icon-192.png' }); } catch { /* some mobiles only notify from a service worker */ }
}

// ------------------------------------------------------------------ context window: a paper stack on each session desk
const desks = new Map(); // seat -> { stack, mat, shredder, label }
const seenCompaction = new Map(); // session -> compactedAt
const deskAt = (seat) => {
  const f = seat.face, fx = Math.sin(f), fz = Math.cos(f), sx = Math.cos(f), sz = -Math.sin(f);
  return { x: seat.x + fx * 0.75, z: seat.z + fz * 0.75, sx, sz };
};
function deskProps(seat) {
  let d = desks.get(seat);
  if (d) return d;
  const { x, z, sx, sz } = deskAt(seat);
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 });
  const stack = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1, 0.36).translate(0, 0.5, 0), mat);
  stack.position.set(x + sx * 0.42, 0.76, z + sz * 0.42);
  stack.castShadow = true;
  scene.add(stack);
  const shredder = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.3), M('#3A3F4B'));
  body.position.y = 0.25;
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.04), M('#111'));
  slot.position.y = 0.51;
  shredder.add(body, slot);
  shredder.position.set(x - sx * 1.0, 0, z - sz * 1.0);
  scene.add(shredder);
  const el = document.createElement('div');
  el.className = 'sign ctx';
  const label = new CSS2DObject(el);
  label.position.set(stack.position.x, 1.45, stack.position.z);
  scene.add(label);
  // the session's badge over its monitor: model, effort, permission mode
  const badge = document.createElement('div');
  badge.className = 'sign badge';
  const badgeO = new CSS2DObject(badge);
  badgeO.position.set(x, 1.72, z);
  scene.add(badgeO);
  d = { stack, mat, shredder, label, el, badge, badgeO, shakeUntil: 0, frac: 0 };
  desks.set(seat, d);
  return d;
}
export function hideContexts() { for (const d of desks.values()) d.stack.visible = d.badgeO.visible = false; }
const MODE = { default: 'asks first', acceptEdits: 'accept edits', plan: 'plan mode', auto: 'auto', bypassPermissions: 'bypass', dontAsk: "don't ask" };
export const modelName = (m = '') => { const x = /claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(m); return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : m.replace(/^claude-/, ''); };
export const modeName = (m) => MODE[m] || m;
/** The badge over a terminal desk: which model, how hard it thinks, how much it may do on its own. */
export function showBadge(agent, x) {
  if (!agent?.home?.screen) return;
  const d = deskProps(agent.home);
  d.badge.textContent = [modelName(x?.model), x?.effort, modeName(x?.mode)].filter(Boolean).join(' · ');
  d.badge.classList.toggle('plan', x?.mode === 'plan');
  d.badgeO.visible = !!x && !!d.badge.textContent;
}
/** Grow the stack with how full the session's context is; on a compaction, feed it to the shredder. */
export function showContext(agent, sid, info) {
  if (!agent?.home?.screen) return;
  const d = deskProps(agent.home);
  const frac = info ? clamp(info.tokens / info.max, 0, 1) : 0;
  d.frac = frac;
  d.stack.visible = d.label.visible = !!info;
  d.el.textContent = info ? `context ${Math.round(frac * 100)}% of ${info.max >= 1e6 ? '1M' : '200k'}` : '';
  d.mat.color.set(frac > 0.85 ? '#F4B4B0' : frac > 0.65 ? '#FBE7B5' : '#FFFFFF');
  const seen = seenCompaction.get(sid);
  const at = info?.compactedAt || 0;
  seenCompaction.set(sid, at);
  // first sight: only replay a compaction that just happened
  if (at && at !== seen && (seen !== undefined || Date.now() - at < 90e3)) shred(agent, d);
}
function shred(agent, d) {
  const from = { root: { position: d.stack.position.clone().setY(0) } }, to = { root: { position: d.shredder.position } };
  for (let k = 0; k < 6; k++) setTimeout(() => fly(from, to, '#9CA3AF'), k * 220);
  d.shakeUntil = now() + 2.2;
  agent.say('compacting… 🗑️', 3);
  sfx('shred', d.shredder.position);
}
function tickDesks(t) {
  for (const d of desks.values()) {
    d.stack.scale.y += (0.02 + d.frac * 0.55 - d.stack.scale.y) * 0.05;
    d.shredder.rotation.z = t < d.shakeUntil ? Math.sin(t * 60) * 0.04 : 0;
    d.label.visible = d.stack.visible && camera.position.distanceTo(d.stack.position) < 20;
    d.label.position.y = d.stack.position.y + d.stack.scale.y + 0.12; // just above the pile, under the bubbles
    if (d.badgeO.visible) d.badgeO.visible = camera.position.distanceTo(d.badgeO.position) < 26;
  }
}

// ------------------------------------------------------------------ the mail cart: a commit lands, a cart delivers it
const GATE = [35.25, 17.5];
const carts = [], queue = [];
let lastCommit = Number(store.get('clawd-mifflin-commit')) || 0;
/** New HQ commits since this page last looked go out by cart, one at a time. */
export function deliveries(list = []) {
  if (!lastCommit) lastCommit = Math.max(Date.now() - 3600e3, ...list.map((c) => c.t)); // first visit: no flood of old news
  for (const c of [...list].sort((a, b) => a.t - b.t)) {
    if (c.t <= lastCommit) continue;
    lastCommit = c.t;
    queue.push(c);
  }
  store.set('clawd-mifflin-commit', String(lastCommit));
  if (!carts.length && queue.length) dispatch(queue.shift());
}
function cartMesh(c) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.36, 0.9), M('#E5484D'));
  body.position.y = 0.3;
  const parcel = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.42), M('#C8935A'));
  parcel.position.set(0, 0.63, 0.1);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.04), M('#2a2a2a'));
  handle.position.set(0, 0.6, -0.45);
  g.add(body, parcel, handle);
  for (const [x, z] of [[-0.3, 0.3], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 12).rotateZ(Math.PI / 2), M('#1b1f2a'));
    w.position.set(x, 0.1, z);
    g.add(w);
  }
  g.traverse((o) => { o.castShadow = true; });
  const el = document.createElement('div');
  el.className = 'sign';
  el.style.background = ctx.hq?.color || '#3B82D6';
  el.textContent = `📦 ${c.hash}`;
  const label = new CSS2DObject(el);
  label.position.y = 1.2;
  g.add(label);
  return g;
}
function dispatch(c) {
  const stops = c.features.map((id) => agents.get(id)).filter(Boolean);
  if (!stops.length) { if (queue.length) dispatch(queue.shift()); return; } // nothing in a feature office: no parcel to take
  const mesh = cartMesh(c);
  mesh.position.set(GATE[0], 0, GATE[1]);
  scene.add(mesh);
  const door = layout.exit.wl;
  // outside the buildings the walk grid is closed, so the cart drives straight from the gate to the door
  const legs = [];
  let at = [door.x, door.z - 0.6];
  for (const a of stops) {
    const s = a.home, side = s.face + Math.PI / 2;
    const [i, j] = nearestFree(...cellOf(s.x + Math.sin(side) * 0.9, s.z + Math.cos(side) * 0.9));
    const target = centre(i, j);
    legs.push({ path: findPath(at[0], at[1], ...target), stop: a });
    at = target;
  }
  legs.push({ path: [...findPath(at[0], at[1], door.x, door.z - 0.6), [GATE[0], GATE[1]]], stop: null });
  legs[0].path.unshift([door.x, door.z - 0.6]);
  carts.push({ mesh, c, legs, wait: 0 });
  sfx('horn', mesh.position);
}
function tickCarts(dt) {
  for (let k = carts.length - 1; k >= 0; k--) {
    const cart = carts[k], p = cart.mesh.position;
    if (cart.wait > 0) { cart.wait -= dt; continue; }
    const leg = cart.legs[0];
    if (!leg) {
      cart.mesh.removeFromParent();
      cart.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose(); if (o.isCSS2DObject) o.element.remove(); });
      carts.splice(k, 1);
      if (queue.length) dispatch(queue.shift());
      continue;
    }
    const pt = leg.path[0];
    if (!pt) {
      const a = leg.stop;
      cart.legs.shift();
      if (a && agents.has(a.id)) {
        a.say(`📦 ${cart.c.subject}`, 5);
        a.celebrateUntil = now() + 0.8;
        sfx('horn', p);
        cart.wait = 3;
      }
      continue;
    }
    const dx = pt[0] - p.x, dz = pt[1] - p.z, d = Math.hypot(dx, dz), step = 2.6 * dt;
    if (d <= step) { p.x = pt[0]; p.z = pt[1]; leg.path.shift(); }
    else { p.x += (dx / d) * step; p.z += (dz / d) * step; cart.mesh.rotation.y = Math.atan2(dx, dz); }
  }
}

// ------------------------------------------------------------------ replay: today, in 90 seconds
export const replay = { on: false, list: [], i: 0, t: 0, t1: 0, speed: 1, onEnd: null };
const MIDNIGHT = () => { const n = Date.now(); return n - ((n + 8 * 3600e3) % 86400e3); };
export function startReplay(list, onEnd) {
  const t0 = list.length ? Math.max(MIDNIGHT(), list[0][0] - 10 * 60e3) : MIDNIGHT();
  Object.assign(replay, { on: true, list, i: 0, t: t0, t1: Date.now(), speed: (Date.now() - t0) / 90, onEnd, until: new Map() });
  for (const a of agents.values()) if (a.working) a.setWork(false);
}
export function stopReplay() {
  if (!replay.on) return;
  replay.on = false;
  for (const a of replay.until.keys()) a.setWork(false);
  replay.onEnd?.();
}
/** Advance the replay clock; returns the MYT hour it shows. */
function tickReplay(dt, t) {
  replay.t += dt * replay.speed;
  const boss = agents.get('claude');
  while (replay.i < replay.list.length && replay.list[replay.i][0] <= replay.t) {
    const [, who, tool, err] = replay.list[replay.i++];
    const a = agents.get(who);
    if (!a || a.disabled) continue;
    a.setWork(true, tool, boss);
    replay.until.set(a, t + 1.5);
    if (err) a.fail(tool);
    if (boss && boss !== a) { boss.setWork(true, 'thinking'); replay.until.set(boss, t + 1.5); }
  }
  for (const [a, until] of replay.until) if (t > until) { a.setWork(false); replay.until.delete(a); }
  if (replay.t >= replay.t1) stopReplay();
  return ((replay.t + 8 * 3600e3) % 86400e3) / 3600e3;
}

// ------------------------------------------------------------------ the Dundies
const DAY_FMT = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export function drawDundies(d) {
  const g = dundieBoard.canvas.getContext('2d'), W = 320;
  const show = d?.last?.awards?.length ? d.last : d?.today;
  g.fillStyle = '#FFF8E1'; g.fillRect(0, 0, W, W);
  g.fillStyle = '#C9A227'; g.fillRect(0, 0, W, 58);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 26px system-ui';
  g.fillText('🏆 THE DUNDIES', W / 2, 30);
  g.font = '14px system-ui';
  g.fillText(!show ? 'awards at midnight' : show === d.last ? `winners of ${DAY_FMT(show.day)}` : 'today so far', W / 2, 50);
  g.textAlign = 'left';
  (show?.awards || []).slice(0, 4).forEach((w, k) => {
    const y = 92 + k * 58, a = agents.get(w.char);
    g.fillStyle = a ? colorOf(a.def) : '#999'; g.fillRect(18, y - 18, 10, 40);
    g.fillStyle = '#7a6f66'; g.font = '13px system-ui'; g.fillText(w.award.toUpperCase(), 38, y - 4);
    g.fillStyle = '#2a2420'; g.font = 'bold 19px system-ui'; g.fillText((a?.def.name || w.char).slice(0, 18), 38, y + 18);
    g.fillStyle = '#7a6f66'; g.font = '13px system-ui'; g.textAlign = 'right'; g.fillText(w.value, W - 16, y + 18); g.textAlign = 'left';
  });
  if (!show?.awards?.length) { g.fillStyle = '#7a6f66'; g.font = '15px system-ui'; g.fillText('nobody has worked yet', 38, 120); }
  dundieBoard.tex.needsUpdate = true;
}
/** Once per new set of winners: they walk up to the board and take a bow. */
export function dundieCeremony(d) {
  const day = d?.last?.day;
  if (!day || store.get('clawd-mifflin-dundies') === day) return;
  store.set('clawd-mifflin-dundies', day);
  d.last.awards.slice(0, 3).forEach((w, k) => {
    const a = agents.get(w.char);
    if (!a || a.working || a.disabled) return;
    setTimeout(() => { if (!a.working) { a.goTo(dundieBoard.spots[k], 'dundie', 10, true); a.task.award = w.award; } }, k * 1500);
  });
}

// ------------------------------------------------------------------ every frame
/** Returns the replay's hour while it runs, otherwise null. */
export function tickExtras(dt, t) {
  ambient(t);
  tickDesks(t);
  tickCarts(dt);
  tickRain(dt);
  tickCat(dt, t);
  tickConfetti(dt);
  if (layout.lab) layout.lab.model.rotation.y += dt * 0.15;
  return replay.on ? tickReplay(dt, t) : null;
}

// ------------------------------------------------------------------ KL weather: Open-Meteo, no key needed
// Rain falls on the campus, clouds dim the sun, thunderstorms flash and switch the lights on early, haze fogs it.
const KL = 'latitude=3.139&longitude=101.687';
export const kl = { temp: null, text: '' };
let wxAt = 0;
const WMO = (c) => (c === 0 ? ['☀️', 'clear'] : c <= 2 ? ['⛅', 'some clouds'] : c === 3 ? ['☁️', 'overcast'] : c <= 48 ? ['🌫️', 'fog'] : c <= 67 ? ['🌧️', 'rain'] : c <= 82 ? ['🌦️', 'showers'] : ['⛈️', 'thunderstorm']);
export async function updateWeather(force = false) {
  const test = new URLSearchParams(location.search).get('weather'); // ?weather=storm|rain|haze|clear to preview
  if (test) return applyWeather({ storm: { code: 95, cloud: 100, pm: 10 }, rain: { code: 63, cloud: 90, pm: 10 }, haze: { code: 2, cloud: 30, pm: 90 } }[test] || { code: 0, cloud: 0, pm: 5 });
  if (!force && Date.now() - wxAt < 15 * 60e3) return;
  wxAt = Date.now();
  try {
    const [w, a] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${KL}&current=temperature_2m,weather_code,cloud_cover,precipitation`).then((r) => r.json()),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${KL}&current=pm2_5`).then((r) => r.json()).catch(() => null),
    ]);
    applyWeather({ code: w.current.weather_code, cloud: w.current.cloud_cover, temp: w.current.temperature_2m, rainMm: w.current.precipitation, pm: a?.current?.pm2_5 ?? 0 });
  } catch { /* offline: keep the last weather */ }
}
function applyWeather({ code, cloud, temp = null, rainMm = 0, pm = 0 }) {
  const storm = code >= 95, wet = (code >= 51 && code <= 67) || code >= 80 || rainMm > 0;
  const haze = pm > 35 ? Math.min(1, 0.3 + (pm - 35) / 60) : code === 45 || code === 48 ? 0.6 : 0;
  setWeather({ cloud: cloud / 100, storm, haze });
  rainAmt = wet ? (storm || code >= 63 || code >= 81 ? 1 : 0.5) : 0;
  rain.visible = rainAmt > 0;
  const [icon, text] = WMO(code);
  kl.temp = temp;
  kl.text = haze >= 0.3 && pm > 35 ? `😷 haze (PM2.5 ${Math.round(pm)})` : `${icon} ${text}`;
  kl.storm = storm;
}
const DROPS = 2400;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(DROPS * 6);
for (let k = 0; k < DROPS; k++) {
  const x = rand(-40, 68), y = rand(0, 28), z = rand(-22, 22);
  rainPos.set([x, y, z, x + 0.03, y + 0.45, z], k * 6);
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: '#A9C7E6', transparent: true, opacity: 0.55, depthWrite: false }));
rain.visible = false;
rain.frustumCulled = false;
scene.add(rain);
let rainAmt = 0, flashAt = 0;
function tickRain(dt) {
  if (!rain.visible) return;
  const fall = (rainAmt > 0.6 ? 26 : 18) * dt, show = Math.floor(DROPS * rainAmt);
  for (let k = 0; k < DROPS; k++) {
    const i = k * 6;
    if (k >= show) { rainPos[i + 1] = rainPos[i + 4] = -50; continue; }
    if (rainPos[i + 1] < -0.5) { rainPos[i + 1] = rand(22, 28); rainPos[i + 4] = rainPos[i + 1] + 0.45; }
    rainPos[i + 1] -= fall; rainPos[i + 4] -= fall;
  }
  rainGeo.attributes.position.needsUpdate = true;
  if (kl.storm && now() > flashAt) {
    flashAt = now() + rand(6, 16);
    const el = document.getElementById('flash');
    el?.animate([{ opacity: 0 }, { opacity: 0.55 }, { opacity: 0.1 }, { opacity: 0.4 }, { opacity: 0 }], { duration: 650 });
    setTimeout(() => sfx('thunder'), rand(300, 1500));
  }
}
SOUNDS.thunder = (v, t) => { hiss('lowpass', 180, 0.35 * v, t, 2.6, 0.7); hiss('lowpass', 90, 0.3 * v, t + 0.15, 3.2, 0.7); };
SOUNDS.meow = (v, t) => {
  const o = ac.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(620, t); o.frequency.linearRampToValueAtTime(880, t + 0.12); o.frequency.linearRampToValueAtTime(520, t + 0.45);
  o.connect(env(0.12 * v, t, 0.02, 0.2, 0.25)); o.start(t); o.stop(t + 0.55);
};
SOUNDS.siren = (v, t) => {
  const o = ac.createOscillator(); o.type = 'sawtooth';
  for (let k = 0; k < 8; k++) { o.frequency.setValueAtTime(700, t + k * 0.6); o.frequency.linearRampToValueAtTime(1100, t + k * 0.6 + 0.3); o.frequency.linearRampToValueAtTime(700, t + k * 0.6 + 0.6); }
  const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2200;
  o.connect(f).connect(env(0.05 * v, t, 0.05, 4.4, 0.4)); o.start(t); o.stop(t + 5);
};
SOUNDS.pop = (v, t) => { for (let k = 0; k < 6; k++) tone('square', 300 + Math.random() * 900, 0.04 * v, t + k * 0.05, 0.05); };

// ------------------------------------------------------------------ the office cat
// Wanders the main office and the rec wing, naps on the busiest keyboard, and follows your mouse for a while
// once you hover over it. Click it for a meow.
const cat = (() => {
  const g = new THREE.Group(), fur = M('#E8A25C'), dark = M('#7A4A22');
  const part = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
  const body = part(0.24, 0.22, 0.5, fur, 0, 0.27, 0);
  const head = part(0.24, 0.21, 0.2, fur, 0, 0.42, 0.3);
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 4), dark);
    ear.position.set(s * 0.07, 0.56, 0.3); g.add(ear);
    part(0.04, 0.04, 0.01, M('#1B1B1B'), s * 0.06, 0.44, 0.405);
  }
  for (const [x, z] of [[-0.08, 0.17], [0.08, 0.17], [-0.08, -0.17], [0.08, -0.17]]) part(0.06, 0.17, 0.06, fur, x, 0.085, z);
  const tail = new THREE.Group();
  tail.position.set(0, 0.33, -0.25);
  const tm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.38, 6), dark);
  tm.position.y = 0.17; tail.add(tm); tail.rotation.x = -0.6;
  g.add(tail);
  for (let k = 0; k < 3; k++) part(0.245, 0.04, 0.05, dark, 0, 0.36, -0.1 + k * 0.12); // tabby stripes
  g.scale.setScalar(1.25);
  g.position.set(-8, 0, 2);
  scene.add(g);
  const el = document.createElement('div');
  el.className = 'bubble hide';
  const bo = new CSS2DObject(el); bo.position.y = 0.9; g.add(bo);
  return { g, body, head, tail, el, path: [], mode: 'wander', until: 0, followUntil: 0, speed: 1.2, bubbleUntil: 0 };
})();
const inMain = (x, z) => (x > MAIN.x0 + 0.3 && x < MAIN.x1 - 0.3 && z > MAIN.z0 + 0.3 && z < MAIN.z1 - 0.3) || (x > REC.x0 + 0.3 && x < REC.x1 && z > REC.z0 + 0.3 && z < REC.z1 - 0.3);
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitPt = new THREE.Vector3();
let mouse = null, repathAt = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  ptr.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  if (ray.ray.intersectPlane(ground, hitPt)) mouse = [hitPt.x, hitPt.z];
  if (ray.intersectObject(cat.g, true).length && now() > cat.followUntil) { cat.followUntil = now() + 10; catSay('😺 mrrp?'); }
});
renderer.domElement.addEventListener('click', () => { if (ray.intersectObject(cat.g, true).length) { catSay('😸 meow!'); sfx('meow', cat.g.position); cat.followUntil = now() + 10; } });
function catSay(text) { cat.el.textContent = text; cat.el.className = 'bubble'; cat.bubbleUntil = now() + 1.8; }
function catGo(x, z) {
  cat.desk = null;
  cat.g.position.y = 0;
  cat.path = findPath(cat.g.position.x, cat.g.position.z, x, z);
}
function catDecide(t) {
  // the busiest keyboard: whoever made the most calls today and is at their desk right now
  const counts = ctx.state?.counts || {};
  const busy = [...agents.values()].filter((a) => a.working && a.task?.arrived && a.task.spot === a.home && a.home.screen && a.b === 'main')
    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0))[0];
  if (busy && Math.random() < 0.6) {
    const s = busy.home, fx = Math.sin(s.face), fz = Math.cos(s.face), sx = Math.cos(s.face), sz = -Math.sin(s.face);
    const desk = [s.x + fx * 0.75 - sx * 0.3, s.z + fz * 0.75 - sz * 0.3];
    const [i, j] = nearestFree(...cellOf(s.x - sx * 0.7, s.z - sz * 0.7));
    catGo(...centre(i, j));
    cat.mode = 'todesk'; cat.target = desk; cat.owner = busy; cat.until = t + 60;
    return;
  }
  const pool = layout.pools.filter(([x, z]) => inMain(x, z));
  const [x, z] = pick(pool) || [-8, 2];
  catGo(x + rand(-1, 1), z + rand(-1, 1));
  cat.mode = 'wander'; cat.until = t + rand(8, 20);
}
function tickCat(dt, t) {
  const g = cat.g, p = g.position;
  if (t > cat.bubbleUntil) cat.el.classList.add('hide');
  if (t < cat.followUntil && mouse && inMain(...mouse) && t > repathAt) { repathAt = t + 0.6; if (Math.hypot(mouse[0] - p.x, mouse[1] - p.z) > 0.8) { catGo(...mouse); cat.mode = 'follow'; } }
  let moving = false;
  if (cat.path.length) {
    const [tx, tz] = cat.path[0], dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz), step = (cat.mode === 'follow' ? 2.4 : cat.speed) * dt;
    if (d <= step) { p.x = tx; p.z = tz; cat.path.shift(); } else { p.x += (dx / d) * step; p.z += (dz / d) * step; g.rotation.y = Math.atan2(dx, dz); }
    moving = true;
    if (!cat.path.length && cat.mode === 'todesk') {
      // hop up and curl up next to the keyboard
      p.set(cat.target[0], 0.77, cat.target[1]);
      cat.mode = 'nap'; catSay('😽 purr');
    }
  } else if (cat.mode === 'nap') {
    if (!cat.owner?.working || t > cat.until) { p.y = 0; catDecide(t); }
  } else if (t > cat.until && t > cat.followUntil) catDecide(t);
  const nap = cat.mode === 'nap';
  cat.body.scale.y = nap ? 0.75 : 1;
  cat.head.position.y = nap ? 0.33 : 0.42 + (moving ? Math.abs(Math.sin(t * 12)) * 0.02 : 0);
  cat.tail.rotation.z = Math.sin(t * (moving ? 6 : 1.5)) * (nap ? 0.15 : 0.5);
}

// ------------------------------------------------------------------ builds: the board in the terminal annex, and reactions
const seenRuns = new Map();
let ciFirst = true;
const WL_LOBBY = new THREE.Vector3(36.5, 1.2, 6.5), MAIN_LOBBY = new THREE.Vector3(-6.3, 1.2, 11);
export function showBuilds(list = []) {
  const g = ciBoard.canvas.getContext('2d'), W = 512, H = 296;
  g.fillStyle = '#0F172A'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#E2E8F0'; g.font = 'bold 26px system-ui'; g.fillText('BUILDS', 18, 38);
  g.fillStyle = '#64748B'; g.font = '15px system-ui'; g.fillText('GitHub Actions · EAS', 120, 37);
  if (!list.length) { g.fillStyle = '#94A3B8'; g.font = '18px system-ui'; g.fillText(ctx.live ? 'no runs found' : 'live view only', 18, 90); }
  list.slice(0, 6).forEach((r, k) => {
    const y = 78 + k * 36, state = r.status === 'completed' ? r.conclusion : 'running';
    g.fillStyle = state === 'success' ? '#22C55E' : state === 'failure' ? '#EF4444' : state === 'running' ? '#F59E0B' : '#64748B';
    g.beginPath(); g.arc(28, y - 6, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#E2E8F0'; g.font = 'bold 17px system-ui'; g.fillText(`${r.repo === 'hq' ? ctx.hq?.short || 'HQ' : 'CM'} · ${r.name}`.slice(0, 34), 46, y);
    g.fillStyle = '#94A3B8'; g.font = '14px system-ui'; g.textAlign = 'right';
    g.fillText(state === 'running' ? 'running…' : `${state} · ${agoShort(r.at)}`, W - 16, y); g.textAlign = 'left';
  });
  ciBoard.tex.needsUpdate = true;
  for (const r of list) {
    const state = r.status === 'completed' ? r.conclusion : 'running', prev = seenRuns.get(r.id);
    if (!ciFirst && prev !== state) {
      if (state === 'failure') ciFail(r);
      else if (state === 'success' && /deploy|pages|release|publish|build|submit/i.test(r.name)) confetti(r.repo === 'hq' ? WL_LOBBY : MAIN_LOBBY);
    }
    seenRuns.set(r.id, state);
  }
  ciFirst = false;
}
const agoShort = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
function ciFail(r) {
  const id = r.repo === 'office' ? 'bash' : /web|site|pages|cloudflare/i.test(r.name) ? ctx.hq?.ci?.web : ctx.hq?.ci?.other;
  const a = agents.get(id);
  if (!a || a.working) return;
  a.goTo(a.home, 'desk', 30, true);
  a.say(`🔴 ${r.name} failed`, 10, 'err');
  a.failUntil = now() + 4;
  sfx('buzz', a.root.position);
}
// a burst of confetti for a green deploy
const bursts = [];
export function confetti(at) {
  const n = 260, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), vel = [];
  const palette = ['#EF4444', '#F59E0B', '#22C55E', '#3B82F6', '#A855F7', '#EC4899', '#D97757'].map((c) => new THREE.Color(c));
  for (let k = 0; k < n; k++) {
    pos.set([at.x, at.y, at.z], k * 3);
    const c = pick(palette); col.set([c.r, c.g, c.b], k * 3);
    vel.push([rand(-3, 3), rand(4, 9), rand(-3, 3)]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.16, vertexColors: true }));
  scene.add(pts);
  bursts.push({ pts, vel, life: 3.2 });
  sfx('pop', at); sfx('fanfare', at);
}
function tickConfetti(dt) {
  for (let k = bursts.length - 1; k >= 0; k--) {
    const b = bursts[k], pos = b.pts.geometry.attributes.position.array;
    b.life -= dt;
    for (let i = 0; i < b.vel.length; i++) {
      const v = b.vel[i];
      v[1] -= 9 * dt; v[0] *= 0.99; v[2] *= 0.99;
      pos[i * 3] += v[0] * dt; pos[i * 3 + 1] = Math.max(0.02, pos[i * 3 + 1] + v[1] * dt); pos[i * 3 + 2] += v[2] * dt;
    }
    b.pts.geometry.attributes.position.needsUpdate = true;
    if (b.life <= 0) { b.pts.removeFromParent(); b.pts.geometry.dispose(); b.pts.material.dispose(); bursts.splice(k, 1); }
  }
}

// ------------------------------------------------------------------ payroll: tokens per session today
const kilo = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const usd = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
export function showPayroll(list = [], cost = null) {
  const g = payBoard.canvas.getContext('2d'), W = 512, H = 296;
  g.fillStyle = '#FBF6EC'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#2A2420'; g.font = 'bold 26px system-ui'; g.fillText('PAYROLL', 18, 38);
  g.fillStyle = '#7A6F66'; g.font = '15px system-ui'; g.fillText('today: tokens · cost at API prices · cache', 140, 37);
  g.fillStyle = '#D9CCB8'; g.fillRect(18, 50, W - 36, 2);
  if (!list.length) { g.fillStyle = '#7A6F66'; g.font = '18px system-ui'; g.fillText(ctx.live ? 'nobody on the clock yet' : 'live view only', 18, 92); }
  list.slice(0, 6).forEach((p, k) => {
    const y = 82 + k * 35, total = p.input + p.cacheWrite + p.cacheRead + p.output, share = p.cacheRead / Math.max(1, p.input + p.cacheWrite + p.cacheRead);
    g.fillStyle = '#2A2420'; g.font = 'bold 16px system-ui'; g.fillText(`${k + 1}. ${p.project}`.slice(0, 24), 18, y);
    g.font = '15px ui-monospace, Menlo, monospace'; g.textAlign = 'right'; g.fillText(kilo(total), 290, y);
    g.font = 'bold 15px ui-monospace, Menlo, monospace'; g.fillStyle = '#B4532A'; g.fillText(p.cost != null ? usd(p.cost) : '', 375, y); g.textAlign = 'left';
    g.fillStyle = '#E8DCC8'; g.fillRect(388, y - 13, 80, 14);
    g.fillStyle = '#3AA76D'; g.fillRect(388, y - 13, 80 * share, 14);
    g.fillStyle = '#2A2420'; g.font = '13px system-ui'; g.fillText(`${Math.round(share * 100)}%`, 472, y - 1);
  });
  g.fillStyle = '#2A2420'; g.font = 'bold 15px system-ui';
  if (cost) g.fillText(`Today ${usd(cost.today)} · this week ${usd(cost.week)}`, 18, H - 30);
  g.fillStyle = '#7A6F66'; g.font = '12px system-ui'; g.fillText('API-price equivalent: on a Claude plan you pay the plan, not this', 18, H - 12);
  payBoard.tex.needsUpdate = true;
}

// ------------------------------------------------------------------ heat map: HQ offices glow with this week's changes
export function showHeat(heat = {}) {
  const max = Math.max(1, ...Object.values(heat));
  for (const o of layout.wlOffices) {
    const v = heat[o.feature.id] || 0;
    o.glow.material.opacity = v ? 0.06 + 0.3 * Math.sqrt(v / max) : 0;
    const a = agents.get(o.feature.id);
    if (a) a.def.heat = v;
  }
}

// ------------------------------------------------------------------ the weekly report
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nameOf = (id) => agents.get(id)?.def.name || id;
export function openReport(r) {
  const box = document.getElementById('report'), body = document.getElementById('report-body');
  if (!r) { body.innerHTML = '<p class="muted">The weekly report needs the live view (it is built from your Claude Code sessions).</p>'; box.hidden = false; return; }
  const fmt = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short' });
  const calls = r.calls.reduce((s, [, n]) => s + n, 0), fails = r.failures.reduce((s, [, n]) => s + n, 0);
  const bars = (rows, unit = '') => { const m = Math.max(1, ...rows.map(([, n]) => n)); return rows.map(([k, n]) => `<div class="rbar"><span>${esc(k)}</span><i style="width:${(n / m) * 100}%"></i><b>${n}${unit}</b></div>`).join(''); };
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const feat = Object.entries(r.commits.perFeature).sort((a, b) => b[1] - a[1]).map(([id, n]) => [nameOf(id), n]);
  body.innerHTML = `
    <h3>Week ${esc(r.week.split('-W')[1])} · ${fmt(r.from)} to ${fmt(Date.now())}</h3>
    <p class="kpis"><b>${calls}</b> tool calls · <b>${fails}</b> failed · <b>${r.sessions}</b> sessions · ${ctx.state?.cost ? `<b>${usd(ctx.state.cost.week)}</b> at API prices · ` : ''}${ctx.hq ? `<b>${r.commits.total}</b> ${esc(ctx.hq.name)} commits · ` : ''}<b>${r.files.count}</b> files edited</p>
    <h2>Calls by day</h2><div class="days">${r.days.map((n, k) => `<div><i style="height:${(n / Math.max(1, ...r.days)) * 60}px"></i><small>${dayNames[k]}</small></div>`).join('')}</div>
    <h2>Busiest staff</h2>${bars(r.calls.slice(0, 8).map(([id, n]) => [nameOf(id), n]))}
    ${r.failures.length ? `<h2>Most failures</h2>${bars(r.failures.map(([id, n]) => [nameOf(id), n]))}` : ''}
    ${feat.length && ctx.hq ? `<h2>Commits per ${esc(ctx.hq.name)} feature</h2>${bars(feat)}` : ''}
    ${r.files.top.length ? `<h2>Files edited most</h2>${bars(r.files.top)}` : ''}
    ${r.dundies.length ? `<h2>Dundies this week</h2>${r.dundies.map((d) => `<div class="rrow"><b>${esc(fmt(Date.parse(`${d.day}T12:00:00+08:00`)))}</b> ${d.awards.map((w) => `${esc(w.award)}: ${esc(nameOf(w.char))}`).join(' · ')}</div>`).join('')}` : ''}`;
  box.hidden = false;
  box.dataset.text = [`Clawd Mifflin weekly report, week ${r.week.split('-W')[1]} (${fmt(r.from)} to ${fmt(Date.now())})`,
    `${calls} tool calls, ${fails} failed, ${r.sessions} sessions, ${ctx.hq ? `${r.commits.total} ${ctx.hq.name} commits, ` : ''}${r.files.count} files edited`,
    `Busiest: ${r.calls.slice(0, 5).map(([id, n]) => `${nameOf(id)} ${n}`).join(', ')}`,
    feat.length && ctx.hq ? `Commits per feature: ${feat.map(([k, n]) => `${k} ${n}`).join(', ')}` : '',
    r.dundies.length ? `Dundies: ${r.dundies.map((d) => `${d.day}: ${d.awards.map((w) => `${w.award} ${nameOf(w.char)}`).join(', ')}`).join('; ')}` : ''].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------ fire drill: weekly usage past 80%
// Once per weekly reset: the alarm goes, the lights flash red and everyone not at work files out to the lawn.
export const drill = { until: 0 };
export function fireDrill() {
  drill.until = now() + 45;
  sfx('siren');
  const el = document.getElementById('flash');
  el?.classList.add('red');
  el?.animate([{ opacity: 0 }, { opacity: 0.35 }, { opacity: 0 }], { duration: 900, iterations: 12 });
  setTimeout(() => el?.classList.remove('red'), 11000);
  let k = 0;
  for (const a of agents.values()) {
    if (a.b !== 'main' || a.working || a.disabled || a.leaving || ['candidate', 'wlcand', 'session', 'intern', 'branch'].includes(a.def.kind)) continue;
    const spot = layout.assembly[k++ % layout.assembly.length];
    setTimeout(() => { if (!a.working) { a.goTo(spot, 'drill', 35, true); a.say('🚨', 3); } }, Math.random() * 2500);
  }
}

// ------------------------------------------------------------------ time-lapse: today's replay, saved as a video
// Records the 3D view while ▶ Replay runs (the name tags and bubbles are page elements, so they are not in it).
export function recordCanvas() {
  const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'];
  const type = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  if (!type) return null;
  const rec = new MediaRecorder(renderer.domElement.captureStream(30), { mimeType: type, videoBitsPerSecond: 6e6 });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.start(1000);
  return () => new Promise((done) => {
    rec.onstop = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(parts, { type }));
      a.download = `clawd-mifflin-${new Date().toISOString().slice(0, 10)}.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      done();
    };
    rec.stop();
  });
}

// ------------------------------------------------------------------ the BIM lab: your newest IFC, or a sample tower
// On the Mac's own page the server hands over the newest .ifc in your home folder (never through the relay);
// web-ifc (WASM, loaded only then) turns it into one mesh on the lab table. Everyone else sees a sample tower.
function labScreen(title, lines) {
  const g = layout.lab.screen.canvas.getContext('2d'), W = 512, H = 280;
  g.fillStyle = '#0B1220'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#22D3EE'; g.font = 'bold 30px system-ui'; g.fillText('BIM LAB', 20, 44);
  g.fillStyle = '#E2E8F0'; g.font = 'bold 20px system-ui'; g.fillText(title.slice(0, 40), 20, 90);
  g.fillStyle = '#94A3B8'; g.font = '16px system-ui';
  lines.forEach((l, k) => g.fillText(l.slice(0, 56), 20, 128 + k * 28));
  layout.lab.screen.tex.needsUpdate = true;
}
function fitOnTable(obj) {
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const k = Math.min(2.2 / Math.max(size.x, size.z, 1e-6), 1.4 / Math.max(size.y, 1e-6));
  obj.position.set(-c.x * k, -box.min.y * k, -c.z * k);
  obj.scale.setScalar(k);
  const pivot = new THREE.Group(); pivot.add(obj);
  layout.lab.model.clear(); layout.lab.model.add(pivot);
}
function sampleTower() {
  const g = new THREE.Group(), slab = M('#E5E7EB'), col = M('#94A3B8'), core = M('#F59E0B');
  const glass = new THREE.MeshStandardMaterial({ color: '#7DD3FC', transparent: true, opacity: 0.35, roughness: 0.1 });
  for (let f = 0; f < 6; f++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(6, 0.25, 4), slab); s.position.y = f * 3; g.add(s);
    if (f < 5) {
      for (const x of [-2.7, -0.9, 0.9, 2.7]) for (const z of [-1.7, 1.7]) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3, 0.3), col); c.position.set(x, f * 3 + 1.5, z); g.add(c); }
      const w = new THREE.Mesh(new THREE.BoxGeometry(6, 2.7, 4), glass); w.position.y = f * 3 + 1.5; g.add(w);
    }
  }
  const k = new THREE.Mesh(new THREE.BoxGeometry(1.4, 15.5, 1.4), core); k.position.set(-1.2, 7.6, 0); g.add(k);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}
export async function initLab(local) {
  if (!layout.lab) return;
  fitOnTable(sampleTower());
  labScreen('sample model', ['a 5-storey frame with a core', local ? 'no .ifc found in your home folder yet' : 'your own IFC shows on the Mac\'s page', 'tip: set ifcPath in the config']);
  if (!local) return;
  const info = await fetch('api/ifc?info').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!info) return;
  labScreen(info.name, [`${(info.size / 1e6).toFixed(1)} MB · loading web-ifc…`]);
  try {
    const CDN = 'https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/';
    const { IfcAPI } = await import(`${CDN}web-ifc-api.js`);
    const api = new IfcAPI();
    api.SetWasmPath(CDN, true);
    await api.Init();
    const data = new Uint8Array(await (await fetch('api/ifc')).arrayBuffer());
    const id = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
    const pos = [], nor = [], col = [], m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3();
    let parts = 0;
    api.StreamAllMeshes(id, (mesh) => {
      for (let i = 0; i < mesh.geometries.size(); i++) {
        const pg = mesh.geometries.get(i), geo = api.GetGeometry(id, pg.geometryExpressID);
        const verts = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize()), idx = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
        m.fromArray(pg.flatTransformation); nm.getNormalMatrix(m);
        for (const j of idx) {
          v.set(verts[j * 6], verts[j * 6 + 1], verts[j * 6 + 2]).applyMatrix4(m); pos.push(v.x, v.y, v.z);
          v.set(verts[j * 6 + 3], verts[j * 6 + 4], verts[j * 6 + 5]).applyMatrix3(nm).normalize(); nor.push(v.x, v.y, v.z);
          col.push(pg.color.x, pg.color.y, pg.color.z);
        }
        geo.delete?.();
        parts++;
      }
    });
    api.CloseModel(id);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }));
    mesh.castShadow = true;
    fitOnTable(mesh);
    labScreen(info.name, [`${parts} elements · ${(pos.length / 9 / 1000).toFixed(0)}k triangles`, `${(info.size / 1e6).toFixed(1)} MB, newest .ifc on this Mac`, 'only on this Mac: never sent online']);
  } catch (e) {
    labScreen(info.name, ['could not read this model', String(e.message || e).slice(0, 56)]);
  }
}

// ------------------------------------------------------------------ branches: other Macs on glass floors over the terminals
export function syncBranches(list = [], quiet = false) {
  const want = new Set();
  document.querySelector('.dock [data-zone=branch]').hidden = !list.length;
  for (const b of list) {
    const floor = branchFloor(b.machine);
    floor.el.textContent = `BRANCH · ${b.machine}${b.offline ? ' (offline)' : b.paused ? ' (paused)' : ''}`;
    (b.sessions || []).slice(0, floor.seats.length).forEach((x, i) => {
      const id = `branch:${b.machine}:${x.id}`;
      want.add(id);
      let a = agents.get(id);
      if (!a) a = addAgent({ id, model: 'claude', name: `Claude · ${x.project} (${b.machine})`, title: `Claude Code session on ${b.machine}`, kind: 'branch', vendor: 'anthropic', seat: floor.seats[i], bio: 'A Claude Code session on another Mac, pushed through the relay.' });
      a.def.session = x;
      const tool = Object.values(b.status || {}).find((st) => st.session === x.id)?.tool;
      const on = !quiet && !b.offline && !b.paused && x.busy;
      a.setWork(on, on ? tool || 'thinking' : '');
    });
  }
  for (const a of agents.values()) if (a.def.kind === 'branch' && !want.has(a.id)) a.gone = true;
}

// ------------------------------------------------------------------ careers: a 30-day sparkline for the panel
export function sparkline(days = []) {
  const max = Math.max(1, ...days), w = 240, h = 44, bw = w / days.length;
  const bars = days.map((n, k) => `<rect x="${(k * bw).toFixed(1)}" y="${(h - (n / max) * h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${((n / max) * h).toFixed(1)}" rx="1"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="calls per day, last 30 days">${bars}</svg>`;
}
