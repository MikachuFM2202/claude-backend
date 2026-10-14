// The staff: character models, the Agent (walking, sitting, working, napping, failing), and the crowd
// that follows the live state (one Claude per session, interns for subagents, HR candidates).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  scene, M, rand, pick, now, findPath, nearestFree, cellOf, centre, spot, faceTo, spots, layout, isNight, mytHours,
  buildingOf, floorText,
} from './world.js';

export const ctx = { hq: null, cast: null, gltf: null, state: null, live: false, selected: null, onSelect: () => {}, sfx: () => {} };
export const agents = new Map();
export const S = 1.3;            // character scale: big enough to read under their speech bubbles
const HIP = 0.3 * S;

export const vendorColor = (v) => (ctx.cast.vendors[v] || ctx.cast.vendors.other).color;
export const colorOf = (def) => def.color || vendorColor(def.vendor) || '#7A8B99';
export const hashColor = (s) => `hsl(${[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360}, 55%, 55%)`;

// ------------------------------------------------------------------ models
// Each character is baked from the Blender cast into a handful of vertex-coloured meshes (torso, eyes,
// two arms, four legs) sharing one material, instead of ~15 meshes with their own materials.
const find = (root, suffix) => { let hit = null; root.traverse((o) => { if (!hit && o.name.endsWith(suffix)) hit = o; }); return hit; };
const under = (o, roots) => { for (let p = o; p; p = p.parent) if (roots.includes(p)) return true; return false; };
function borrowAccessories(model, donorId) {
  const donor = ctx.gltf.getObjectByName(`c_${donorId}`);
  if (!donor) return;
  for (const suffix of ['__body', '__armL', '__armR']) {
    const from = find(donor, suffix), to = find(model, suffix);
    if (from && to) for (const ch of from.children) if (ch.name.includes('__acc')) to.add(ch.clone(true));
  }
}
function bakeGeometry(meshes, frameInv, tint) {
  const geos = meshes.map((m) => {
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(frameInv, m.matrixWorld));
    const c = tint && /__(body|arm|leg)/.test(m.name) && !m.name.includes('__acc') ? tint : m.material.color;
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  });
  return geos.length ? mergeGeometries(geos) : null;
}
export function buildRig(def) {
  const own = ctx.gltf.getObjectByName(`c_${def.model || def.id}`);
  const src = (own || ctx.gltf.getObjectByName('c_generic')).clone(true);
  src.position.set(0, 0, 0);
  if (!own && def.donor) borrowAccessories(src, def.donor);
  src.updateMatrixWorld(true);
  const tint = own ? null : new THREE.Color(def.color || def.known || (def.vendor && def.vendor !== 'other') ? colorOf(def) : hashColor(def.id));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  const body = find(src, '__body'), armL = find(src, '__armL'), armR = find(src, '__armR');
  const legs = ['FL', 'FR', 'BL', 'BR'].map((k) => find(src, `__leg${k}`));
  const eyes = [find(src, '__eyeL'), find(src, '__eyeR')].filter(Boolean);
  const floats = [];
  src.traverse((o) => { if (o.name.includes('__acc_float')) floats.push(o); });
  const meshesUnder = (root, skip = []) => { const out = []; root.traverse((o) => { if (o.isMesh && !under(o, skip)) out.push(o); }); return out; };
  const id = new THREE.Matrix4();
  const rig = new THREE.Group(), torso = new THREE.Group();
  rig.add(torso);
  const mk = (geo, cast = false) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = false; return m; };
  torso.add(mk(bakeGeometry(meshesUnder(body, [...eyes, ...floats]), id, tint), true));
  // eyes as one mesh with its origin at eye height, so they can blink and close
  let eyeMesh = null;
  if (eyes.length) {
    const ey = new THREE.Vector3().setFromMatrixPosition(eyes[0].matrixWorld).y;
    const g = bakeGeometry(eyes, new THREE.Matrix4().makeTranslation(0, -ey, 0), null);
    eyeMesh = mk(g);
    eyeMesh.position.y = ey;
    torso.add(eyeMesh);
  }
  const limb = (obj) => {
    if (!obj) return null;
    const m = mk(bakeGeometry(meshesUnder(obj, floats), obj.matrixWorld.clone().invert(), tint));
    obj.matrixWorld.decompose(m.position, m.quaternion, m.scale);
    return m;
  };
  const aL = limb(armL), aR = limb(armR);
  if (aL) torso.add(aL);
  if (aR) torso.add(aR);
  const legMeshes = legs.map((l) => { const m = limb(l); if (m) rig.add(m); return m; });
  const floatMeshes = floats.map((f) => {
    const m = mk(bakeGeometry(meshesUnder(f), f.matrixWorld.clone().invert(), null));
    f.matrixWorld.decompose(m.position, m.quaternion, m.scale);
    torso.add(m);
    return [m, m.position.y];
  });
  return { rig, torso, armL: aL, armR: aR, legs: legMeshes, eyes: eyeMesh, floats: floatMeshes, mat };
}

// a soft halo behind someone at work
const haloTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.35)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const RED = new THREE.Color('#E5484D');
const WAIT_TEXT = { permission: '✋ needs your OK', input: '👋 waiting for you', reply: '👋 your turn', plan: '📝 plan mode' };

// ------------------------------------------------------------------ flights: paper handed between characters
const flights = [];
export function fly(from, to, color) {
  if (!from || !to || from === to) return;
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.02, 0.36), M('#ffffff', { emissive: new THREE.Color(color), emissiveIntensity: 0.6 }));
  scene.add(m);
  flights.push({ m, from, to, t: 0, dur: Math.min(3, 1.2 + from.root.position.distanceTo(to.root.position) / 25) });
}
export function updateFlights(dt) {
  for (let k = flights.length - 1; k >= 0; k--) {
    const f = flights[k];
    f.t += dt / f.dur;
    const a = f.from.root.position, b = f.to.root.position, u = Math.min(f.t, 1);
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    f.m.position.set(a.x + (b.x - a.x) * u, 1.3 + Math.sin(u * Math.PI) * (1.5 + d * 0.12), a.z + (b.z - a.z) * u);
    f.m.rotation.y += dt * 8;
    if (f.t >= 1) { f.m.removeFromParent(); f.m.geometry.dispose(); flights.splice(k, 1); }
  }
}

// ------------------------------------------------------------------ ping pong (ball flies only with two players)
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), M('#ffffff', { emissive: 0x333333 }));
ball.visible = false;
scene.add(ball);
let pingPongLive = false, lastHit = 0;
export function updatePingPong(t) {
  const [a, b] = spots.main.pingpong;
  pingPongLive = !!(a?.taken?.task?.arrived && b?.taken?.task?.arrived && a.taken.task.spot === a && b.taken.task.spot === b);
  ball.visible = pingPongLive;
  if (!pingPongLive) return;
  const hit = Math.floor((t * 3) / Math.PI + 0.5); // the ball reaches a paddle at each end of the sine
  if (hit !== lastHit) { lastHit = hit; ctx.sfx('tock', ball.position); }
  const u = (Math.sin(t * 3) + 1) / 2;
  ball.position.set(-11.5 + u * 2.6, 0.8 + Math.abs(Math.sin(t * 6)) * 0.35, -5.7 + Math.sin(t * 1.7) * 0.4);
}

// ------------------------------------------------------------------ the agent
export class Agent {
  constructor(def, home, spawnAt = null) {
    this.def = def;
    this.id = def.id;
    this.home = home;
    this.b = buildingOf(home.x);
    this.root = new THREE.Group();
    Object.assign(this, buildRig(def));
    this.rig.scale.setScalar(S);
    this.root.add(this.rig);
    this.rig.traverse((o) => { o.userData.agent = this; });
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: colorOf(def), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
    this.halo.scale.setScalar(2.1);
    this.halo.position.y = 0.55 * S;
    this.halo.visible = false;
    this.root.add(this.halo);
    scene.add(this.root);

    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.style.setProperty('--c', colorOf(def));
    tag.onclick = () => ctx.onSelect(this);
    this.tagEl = tag;
    this.root.add(new CSS2DObject(tag));
    const bub = document.createElement('div');
    bub.className = 'bubble hide';
    this.bubbleEl = bub;
    const bo = new CSS2DObject(bub);
    bo.position.y = 1.15 * S + 0.25;
    this.root.add(bo);

    this.working = false;
    this.tool = '';
    this.path = [];
    this.phase = Math.random() * 10;
    this.nextBlink = now() + rand(2, 5);
    this.bubbleUntil = 0;
    this.mug = null;
    this.mugUntil = 0;
    this.celebrateUntil = 0;
    this.failUntil = 0;
    if (spawnAt) {
      this.root.position.set(spawnAt.x, 0, spawnAt.z);
      this.pose = 'stand';
      this.task = { kind: 'desk', spot: home, end: 0, arrived: true };
    } else {
      this.root.position.set(home.x, home.pose === 'sit' ? home.seatY - HIP : 0, home.z);
      this.root.rotation.y = home.face;
      this.pose = home.pose;
      this.task = { kind: 'desk', spot: home, end: now() + rand(2, 12), arrived: true };
    }
    this.refreshTag();
  }
  get disabled() { return this.def.enabled === false; }
  refreshTag() {
    this.tagEl.classList.toggle('off', this.disabled);
    this.tagEl.textContent = (this.def.name || this.id) + (this.disabled ? ' (off)' : this.def.needsAuth ? ' (sign in)' : '');
  }
  say(text, secs = 3, cls = '') {
    this.bubbleEl.textContent = text;
    this.bubbleEl.className = `bubble ${cls}`;
    this.bubbleUntil = cls === 'work' || cls === 'wait' ? Infinity : now() + secs;
  }
  /** A session Claude waiting for you walks to its door and waves; `kind` null sends it back to work. */
  wait(kind, at) {
    if (kind === (this.waitKind || null)) return;
    this.waitKind = kind;
    if (kind) {
      this.goTo(at, 'wait', Infinity);
      this.say(WAIT_TEXT[kind] || 'your turn 👋', 0, 'wait');
    } else {
      this.bubbleUntil = 0;
      if (this.task?.kind === 'wait') this.task.end = 0;
    }
  }
  snooze(secs) {
    this.bubbleEl.replaceChildren(...['z', 'Z', 'z', 'Z'].map((ch, i) => { const s = document.createElement('span'); s.textContent = ch; s.style.animationDelay = `${i * 0.35}s`; return s; }));
    this.bubbleEl.className = 'bubble zzz';
    this.bubbleUntil = now() + secs;
  }
  /** Start or stop work. `from` is who handed the work over (the session's Claude). */
  setWork(on, tool, from = null) {
    if (on) {
      this.tool = tool || 'working';
      this.say(this.tool, 0, 'work');
      if (!this.working) {
        this.working = true;
        this.from = from;
        if (this.id === 'hooks') fly(this, from, colorOf(this.def));
        else if (from && from !== this) fly(from, this, colorOf(this.def));
        this.goTo(this.home, 'work', 0, true);
      }
    } else if (this.working) {
      this.working = false;
      if (this.from && this.from !== this && this.id !== 'hooks') fly(this, this.from, colorOf(this.def));
      this.say(pick(['done ✓', 'shipped ✓', 'nailed it', '✓']), 2.5);
      this.celebrateUntil = now() + 0.8;
      this.task = { kind: 'desk', spot: this.home, end: now() + rand(3, 6), arrived: this.task?.arrived };
    }
  }
  /** A tool call came back with an error: slump, flash red, say so. */
  fail(tool) {
    this.failUntil = now() + 3.5;
    ctx.sfx('buzz', this.root.position);
    this.say(`✗ ${tool}`, 3.5, 'err');
  }
  leave() {
    this.leaving = true;
    this.working = false;
    this.goTo(layout.exit[this.b], 'leave', 0);
  }
  release() { if (this.task?.spot?.taken === this) this.task.spot.taken = null; }
  goTo(target, kind, secs, hurry = false) {
    if (!target) return;
    if (this.task?.kind === 'sleep' && this.bubbleUntil !== Infinity) this.bubbleUntil = 0;
    this.release();
    target.taken = this;
    this.task = { kind, spot: target, end: Infinity, secs, arrived: false };
    this.hurry = hurry;
    const p = this.root.position;
    if (Math.hypot(p.x - target.x, p.z - target.z) < 0.05) { this.arrive(); return; }
    this.path = findPath(p.x, p.z, target.ax, target.az);
    if (target.ax !== target.x || target.az !== target.z) this.path.push([target.x, target.z]);
    this.pose = 'walk';
  }
  arrive() {
    const t = this.task, s = t.spot;
    t.arrived = true;
    this.root.position.set(s.x, s.pose === 'sit' ? s.seatY - HIP : s.y || 0, s.z);
    this.targetYaw = s.face;
    this.pose = t.kind === 'sleep' ? (s.pose === 'sit' ? 'sleepsit' : 'sleep') : s.pose;
    t.end = now() + (t.secs || 0);
    if (t.kind === 'leave') { this.gone = true; return; }
    if (t.kind === 'work') return;
    if (t.kind === 'sleep' && !isNight(mytHours()) && !this.disabled) t.end = now(); // woke up: the time changed while walking
    const line = {
      coffee: ['☕', 'coffee time', 'decaf? never.'], vending: ["snack o'clock", 'B4 please', '🍫'], fridge: ['who took my yoghurt?', "Kevin's chili again"],
      window: ['nice view', 'is it raining?', 'KL skyline ✨'], cooler: ['did you see that PR?', 'hydrate', 'water cooler gossip'],
      phone: ['on a call 📞', 'can you hear me now?', "you're on mute"], lounge: ['5 minute break', 'nice sofa'], copier: ['PC LOAD LETTER?', 'jammed again'],
      pool: ['8 ball, corner pocket', 'nice shot', 'scratch!'], foosball: ['GOAL!', 'no spinning!'], arcade: ['new high score!', 'insert coin', 'one more go'],
      darts: ['bullseye!', 'missed the board…'], treadmill: ['cardio 🏃', 'one more km'], weights: ['💪', 'do you even lift?'],
      yoga: ['namaste 🧘', 'downward dog'], beanbag: ['so comfy', 'five more minutes'],
      lab: ['clash detection: 0 clashes 😎', 'LOD 400 or bust', 'who moved the column?', 'IFC looks clean'], drill: ['🚨 fire drill!', 'is this real?', 'I left my coffee!'],
    }[t.kind];
    if (line) this.say(pick(line), 2.5);
    if (t.kind === 'coffee') { this.mugUntil = now() + 40; ctx.sfx('hiss', this.root.position); }
    if (t.kind === 'dundie') { this.say(`🏆 ${t.award}`, 6); this.celebrateUntil = now() + 0.8; ctx.sfx('fanfare', this.root.position); }
    if (t.kind === 'sleep') this.snooze(600);
    if (t.kind === 'meeting' && this.def.kind === 'boss') this.say('Conference room, five minutes!', 4);
    if (t.kind === 'visit' && t.who) {
      this.say(pick(this.def.lines || ['how is it going?', 'got a sec?', 'nice desk']), 3.5);
      setTimeout(() => t.who.say(t.who.working ? 'busy!' : pick(t.who.def.lines || ['ha!', 'sure', 'later?']), 2.5), 1600);
    }
  }
  // Pick something to do while not working. The Office rules: coffee, couch, gossip, ping pong.
  idle() {
    const kind = this.def.kind;
    if (kind === 'intern') return this.leave();
    if (kind === 'branch') return this.goTo(this.home, 'desk', 30); // up on the glass floor: they stay put
    if (kind === 'candidate' || kind === 'wlcand') {
      if (Math.random() < 0.4) { this.celebrateUntil = now() + 0.8; this.say(pick(['pick me!', 'I have references', 'I work weekends', 'is there free coffee?']), 3); }
      return this.goTo(this.home, 'desk', rand(15, 40));
    }
    if (this.disabled) return this.goTo(this.home, 'sleep', 600);
    const pools = spots[this.b];
    const at = (k, kind, a, b) => { const free = (pools[k] || []).filter((s) => !s.taken && !s.owner); return free.length ? () => this.goTo(pick(free), kind, rand(a, b)) : null; };
    const boss = kind === 'boss' || kind === 'session';
    const limit = (ctx.state?.usage?.session?.pct ?? 0) >= 100;
    const opts = [];
    const add = (w, fn) => fn && opts.push([w, fn]);
    // the rec wing: games, gym, beanbags (only the main building has these, so elsewhere they are skipped)
    const rec = (k = 1) => {
      add(2 * k, at('pool', 'pool', 15, 35)); add(1.5 * k, at('foosball', 'foosball', 15, 30)); add(2 * k, at('arcade', 'arcade', 10, 25));
      add(1 * k, at('darts', 'darts', 8, 15)); add(1.5 * k, at('treadmill', 'treadmill', 15, 30)); add(1 * k, at('weights', 'weights', 10, 20));
      add(1 * k, at('yoga', 'yoga', 15, 30)); add(2 * k, at('beanbag', 'beanbag', 15, 35));
      add(1.2 * k, at('lab', 'lab', 12, 25)); add(0.6 * k, at('pod', 'sleep', 20, 40));
    };
    if (limit) {
      add(3, at('couch', 'couch', 20, 40)); add(3, at('table', 'table', 20, 40)); add(1, at('lounge', 'lounge', 20, 40)); add(2, at('pingpong', 'pingpong', 20, 40));
      add(2, at('coffee', 'coffee', 6, 10)); add(1, at('vending', 'vending', 5, 8));
      rec(1.5);
    } else if (isNight(mytHours())) {
      // night: most nap on sofas and beanbags rather than slumped over their desks
      add(boss ? 4 : 1.5, () => this.goTo(this.home, 'sleep', rand(60, 140)));
      add(3, at('couch', 'sleep', 60, 140)); add(2, at('lounge', 'sleep', 60, 140)); add(3, at('beanbag', 'sleep', 60, 140)); add(5, at('pod', 'sleep', 80, 160));
      add(1, at('fridge', 'fridge', 4, 6)); add(0.5, at('arcade', 'arcade', 10, 20));
    } else {
      // staff are only at their desks to work: idle time goes to the office, the break room and the rec wing
      add(boss ? 2 : 0.6, () => this.goTo(this.home, 'desk', rand(8, 20)));
      rec();
      add(2, at('coffee', 'coffee', 4, 7));
      add(1, at('vending', 'vending', 4, 6));
      add(1, at('fridge', 'fridge', 4, 6));
      add(2, at('couch', 'couch', 12, 30));
      add(2, at('table', 'table', 12, 30));
      add(1.5, at('pingpong', 'pingpong', 18, 35));
      add(2, at('cooler', 'cooler', 6, 12));
      add(0.7, at('copier', 'copier', 4, 7));
      add(1, at('window', 'window', 6, 12));
      add(1, at('phone', 'phone', 8, 16));
      add(1.5, at('lounge', 'lounge', 10, 25));
      add(boss || kind === 'hr' ? 5 : 1.5, () => this.visit());
      if (kind === 'boss') add(1, () => this.callMeeting());
    }
    let r = Math.random() * opts.reduce((s, o) => s + o[0], 0);
    for (const [w, fn] of opts) if ((r -= w) <= 0) return fn();
    this.goTo(this.home, 'desk', 10);
  }
  visit() {
    const pool = [...agents.values()].filter((a) => a !== this && a.b === this.b && !a.leaving && a.def.kind !== 'branch' && a.task?.arrived && a.task.spot
      && (this.def.kind !== 'hr' || a.def.kind === 'candidate' || Math.random() < 0.3));
    const who = pick(pool);
    if (!who) return this.goTo(this.home, 'desk', 10);
    const s = who.task.spot;
    const side = Math.random() < 0.5 ? 1 : -1, yaw = s.face + side * Math.PI / 2;
    const [i, j] = nearestFree(...cellOf(s.x + Math.sin(yaw) * 0.85, s.z + Math.cos(yaw) * 0.85));
    const [cx, cz] = centre(i, j);
    this.goTo(spot(cx, cz, faceTo(s.x - cx, s.z - cz)), 'visit', rand(5, 9));
    this.task.who = who;
  }
  callMeeting() {
    const conf = spots.main.conf, head = conf.at(-1);
    if (head.taken || head.owner) return this.visit();
    this.goTo(head, 'meeting', 25);
    for (const a of agents.values()) {
      if (a === this || a.b !== 'main' || a.working || a.disabled || a.leaving || ['candidate', 'wlcand', 'intern', 'session'].includes(a.def.kind) || Math.random() > 0.35) continue;
      const free = conf.filter((s) => !s.taken && !s.owner);
      if (!free.length) break;
      a.goTo(free[0], 'meeting', rand(20, 28));
    }
  }
  update(dt, t) {
    const task = this.task;
    if (this.pose === 'walk' && this.path.length) {
      const [tx, tz] = this.path[0];
      const p = this.root.position;
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      const speed = (this.hurry ? 3.0 : 1.5) * dt;
      p.y = 0;
      if (d <= speed) { p.x = tx; p.z = tz; this.path.shift(); }
      else { p.x += (dx / d) * speed; p.z += (dz / d) * speed; this.targetYaw = Math.atan2(dx, dz); }
      if (!this.path.length) this.arrive();
    } else if (this.pose === 'walk') this.arrive();
    if (task?.arrived && !this.working && !this.leaving && t > task.end) this.idle();
    if (this.targetYaw !== undefined) {
      let dy = this.targetYaw - this.root.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.root.rotation.y += dy * Math.min(1, dt * 10);
    }
    this.animate(dt, t);
    if (this.bubbleUntil !== Infinity && t > this.bubbleUntil) this.bubbleEl.classList.add('hide');
    if (task?.kind === 'sleep' && !task.arrived) this.bubbleEl.classList.add('hide');
    const wantMug = t < this.mugUntil && !this.working;
    if (wantMug && !this.mug && this.armR) {
      this.mug = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.1, 10), M('#ffffff'));
      this.mug.position.set(0.12, -0.02, 0.1);
      this.armR.add(this.mug);
    } else if (!wantMug && this.mug) { this.mug.removeFromParent(); this.mug = null; }
  }
  animate(dt, t) {
    const pose = this.pose, L = this.legs, tor = this.torso;
    this.phase += dt * (pose === 'walk' ? (this.hurry ? 14 : 9) : 1);
    const s = Math.sin(this.phase);
    let legX = 0, armZ = 0, bob = 0, tilt = 0, roll = 0;
    const failing = t < this.failUntil;
    if (pose === 'walk') { legX = s * 0.65; bob = Math.abs(s) * 0.05; roll = s * 0.06; armZ = s * 0.4; }
    const seated = pose === 'sit' || pose === 'sleepsit';
    if (seated) legX = -Math.PI / 2;
    const sleepy = pose === 'sleep' || pose === 'sleepsit';
    if (sleepy) { tilt = 0.35; bob = Math.sin(t * 1.5) * 0.01; }
    else if (failing) { tilt = 0.45; armZ = -0.55; bob = Math.sin(t * 9) * 0.01; }
    else if (this.working && this.task?.arrived) { armZ = Math.sin(t * 22) * 0.35; bob = Math.abs(Math.sin(t * 11)) * 0.015; tilt = 0.08; }
    else if (pose !== 'walk' && ctx.music && this.task?.kind !== 'desk') { bob = Math.abs(Math.sin(t * 7.5 + this.phase)) * 0.04; roll = Math.sin(t * 3.75 + this.phase) * 0.08; } // Spotify is on: dance
    else if (pose !== 'walk') bob = Math.sin(t * 2 + this.phase) * 0.008;
    if (this.waitKind && this.task?.kind === 'wait' && this.task.arrived) armZ = 0; // the right arm waves below
    const act = this.task?.arrived && !this.working ? this.task.kind : null;
    if (act === 'treadmill') { legX = Math.sin(t * 12) * 0.6; bob = Math.abs(Math.sin(t * 12)) * 0.05; armZ = Math.sin(t * 12) * 0.4; }
    else if (act === 'arcade' || act === 'foosball') armZ = Math.sin(t * (act === 'arcade' ? 18 : 9)) * 0.35;
    else if (act === 'yoga') tilt = 0.25 + Math.sin(t * 0.8) * 0.25;
    if (this.task?.kind === 'pingpong' && this.task.arrived && pingPongLive) armZ = Math.sin(t * 6 + (this.task.spot === spots.main.pingpong[0] ? 0 : Math.PI)) * 0.8;
    if (L[0]) { L[0].rotation.x = L[3].rotation.x = legX; L[1].rotation.x = L[2].rotation.x = seated ? legX : -legX; }
    const cheer = t < this.celebrateUntil ? 1.2 : 0;
    if (this.armL) { this.armL.rotation.z = (failing ? 0.55 : -armZ) - cheer; this.armR.rotation.z = (failing ? -0.55 : pose === 'walk' ? -armZ : armZ) + cheer; }
    if (this.armR && this.waitKind && this.task?.kind === 'wait' && this.task.arrived) {
      this.armR.rotation.z = this.waitKind === 'plan' ? 0.9 + Math.sin(t * 9) * 0.15 : 1.1 + Math.sin(t * (this.waitKind === 'permission' ? 12 : 7)) * 0.45; // sketch, or wave
    }
    if (this.armL && act === 'weights') { const lift = 1.3 + Math.sin(t * 3) * 0.6; this.armL.rotation.z = -lift; this.armR.rotation.z = lift; }
    const hop = cheer ? Math.sin(((this.celebrateUntil - t) / 0.8) * Math.PI) * 0.25 : 0;
    tor.position.y = bob + hop;
    tor.rotation.x = tilt;
    tor.rotation.z = roll;
    if (t > this.nextBlink) this.nextBlink = t + rand(2.5, 6);
    if (this.eyes) this.eyes.scale.y = sleepy ? 0.15 : t > this.nextBlink - 0.12 ? 0.1 : 1;
    for (const [o, y0] of this.floats) { o.rotation.y += dt * 1.5; o.position.y = y0 + Math.sin(t * 2 + this.phase) * 0.03; }
    // a faint glow over the whole body while working, red while a call failed
    const glowing = this.working && this.task?.arrived;
    if (failing) this.mat.emissive.copy(RED).multiplyScalar(0.25 + 0.2 * Math.abs(Math.sin(t * 8)));
    else if (glowing) this.mat.emissive.set(colorOf(this.def)).multiplyScalar(0.22 + 0.1 * Math.sin(t * 4));
    else this.mat.emissive.setRGB(0, 0, 0);
    this.halo.visible = glowing || failing;
    if (this.halo.visible) {
      this.halo.material.color.set(failing ? RED : colorOf(this.def));
      this.halo.material.opacity = 0.45 + 0.15 * Math.sin(t * 4);
    }
  }
  dispose() {
    this.release();
    if (this.home?.owner === this.id) { this.home.owner = null; if (this.home.screen) this.home.screen.owner = null; }
    this.root.removeFromParent();
    this.root.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.mat.dispose();
    this.halo.material.dispose();
    agents.delete(this.id);
    if (ctx.selected === this) ctx.selected = null;
  }
}

// ------------------------------------------------------------------ hiring: who sits where
const free = (list) => list.find((s) => !s.owner);
export function seatFor(def) {
  switch (def.kind) {
    case 'boss': return layout.boss;
    case 'archive': return layout.archive;
    case 'reception': return layout.reception;
    case 'hr': return layout.hrDesk;
    case 'session': return free(layout.terminals) || free(spots.main.conf);
    case 'intern': return free(spots.main.conf) || free(layout.cowork) || free(layout.desks);
    case 'candidate': return free(layout.cand);
    case 'wlcand': return free(layout.wlFuture[def.room] || layout.fair[def.room] || []);
    case 'branch': return def.seat;
    case 'wl': return layout.wlOffices.find((o) => o.feature.id === def.id)?.seat;
    case 'mcp': return free(layout.mcpOffices.map((o) => o.seat));
    case 'plugin': case 'skill':
      // Claude's own family sits in the bullpen pods; partners from other companies share the co-working table
      return def.vendor === 'anthropic' ? free(layout.desks) : free(layout.cowork) || free(layout.desks);
    default: return free(layout.desks);
  }
}
export function addAgent(def, spawnAt = null) {
  const home = seatFor(def) || free(layout.desks) || spot(rand(-10, 5), rand(9, 11), 0);
  home.owner = def.id;
  const a = new Agent(def, home, spawnAt);
  if (home.screen) home.screen.owner = a;
  agents.set(def.id, a);
  const office = layout.mcpOffices.find((o) => o.seat === home);
  if (office && !office.named) { office.named = true; floorText((def.name || def.id).toUpperCase(), office.x, office.z, { w: office.w, color: colorOf(def), alpha: 0.75 }); }
  if (spawnAt) a.goTo(home, def.kind === 'intern' ? 'work' : 'desk', rand(10, 20), def.kind === 'intern');
  return a;
}

// ------------------------------------------------------------------ the crowd follows the state
const BOSS_LINES = ["Would I rather be feared or loved? Easy. Helpful.", 'I am running on pure caffeine and context.', 'Conference room, five minutes!', "That's what the user said."];
function candidateDef(p, kind, extra = {}) {
  const vendor = /anthropic/i.test(p.author || '') ? 'anthropic' : 'other';
  return {
    id: `${kind === 'candidate' ? 'cand' : 'wlcand'}:${p.name}`, name: (p.displayName || p.name).replace(/^(.{22}).+$/, '$1…'), title: `${p.category} · ${kind === 'candidate' ? 'candidate' : `candidate for ${ctx.hq?.name || 'HQ'}`}`, kind, vendor,
    color: vendor === 'anthropic' ? null : hashColor(p.author || p.name), donor: ctx.cast.donors[p.category] || ctx.cast.donors.other,
    desc: p.description, why: p.why, install: p.install, author: p.author, category: p.category, url: p.url, homepage: p.homepage, pros: p.pros, cons: p.cons, ...extra,
  };
}
export function hireWL() {
  for (const f of ctx.hq?.features || []) {
    if (!agents.has(f.id)) addAgent({ id: f.id, name: f.name, title: f.title, kind: 'wl', vendor: 'hq', color: ctx.hq.color, donor: f.donor, bio: `Works when a session touches ${f.paths.slice(0, 3).join(', ')}…`, paths: f.paths });
  }
}
/** Bring the cast in line with a state: rosters, sessions, interns, candidates. Returns who works for which session. */
export function syncCrowd(s) {
  const boss = agents.get('claude');
  // roster
  const ids = new Set(s.characters.map((c) => c.id));
  for (const def of s.characters) if (def.id !== 'generic' && !agents.has(def.id)) addAgent(def);
  for (const def of s.characters) { const a = agents.get(def.id); if (a) { a.def = { ...a.def, ...def }; a.refreshTag(); } }
  for (const a of agents.values()) {
    if (['core', 'plugin', 'skill', 'mcp'].includes(a.def.kind) && !ids.has(a.id) && a.def.enabled !== false) { a.def = { ...a.def, enabled: false }; a.refreshTag(); }
  }
  // one Claude per terminal (Claude Code session), up to five, at the desks in the terminal annex;
  // the boss stays in its office and works whenever any of them does
  const sessions = s.sessions || [];
  const sessionAgent = new Map();
  if (boss) boss.def.lines = BOSS_LINES;
  const want = new Set(sessions.slice(0, 5).map((x) => `session:${x.id}`));
  for (const x of sessions.slice(0, 5)) {
    const id = `session:${x.id}`;
    let a = agents.get(id);
    if (!a) a = addAgent({ id, model: 'claude', name: `Claude · ${x.project}`, title: 'Claude Code session (terminal)', kind: 'session', vendor: 'anthropic', bio: 'A Claude Code session running in a terminal right now.', lines: BOSS_LINES }, layout.exit.term);
    sessionAgent.set(x.id, a);
  }
  for (const a of agents.values()) if (a.def.kind === 'session' && !want.has(a.id) && !a.leaving) a.leave();
  // interns: one per running subagent, hired by the session that started it
  const running = new Set((s.subagents || []).map((x) => `intern:${x.id}`));
  for (const x of s.subagents || []) {
    const id = `intern:${x.id}`;
    if (agents.has(id)) continue;
    const from = sessionAgent.get(x.session) || boss;
    // interns work in the main building: one hired from the terminal annex walks in at the front door
    const a = addAgent({ id, model: 'agent', name: `${x.type} intern`, title: x.desc || 'subagent', kind: 'intern', vendor: 'anthropic', bio: 'A subagent Claude sent off to work on its own.' }, from?.b === 'main' ? from.root.position : layout.exit.main);
    a.setWork(true, `${x.type}: ${x.desc}`.slice(0, 60), from);
  }
  for (const a of agents.values()) if (a.def.kind === 'intern' && !running.has(a.id) && a.working) a.setWork(false);
  // HR: this week's picks, the careers fair, and the HQ's hiring rooms
  const hr = s.hr;
  if (hr) {
    const wantCand = new Set();
    for (const p of hr.picks || []) {
      const def = candidateDef(p, 'candidate');
      wantCand.add(def.id);
      if (!agents.has(def.id)) addAgent(def);
    }
    for (const [room, list] of Object.entries(hr.rooms || {})) for (const p of list) {
      const fair = ctx.cast.fair?.find((f) => f.id === room);
      const def = candidateDef(p, 'wlcand', { room, ...(fair ? { title: `${p.category} · careers fair: ${fair.name}` } : {}) });
      wantCand.add(def.id);
      if (!agents.has(def.id)) addAgent(def);
    }
    for (const a of agents.values()) if ((a.def.kind === 'candidate' || a.def.kind === 'wlcand') && !wantCand.has(a.id) && !a.leaving) a.leave();
    for (const [id, plugins] of Object.entries(hr.features || {})) { const a = agents.get(id); if (a) a.def.plugins = plugins; }
  }
  for (const a of [...agents.values()]) if (a.gone) a.dispose();
  return { sessionAgent, boss };
}
