// The campus: renderer, camera, light, the home kit (instanced), walls, floors, furniture, navigation grid,
// and day and night. Every building is built here; the HQ only when the state brings its private config.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const $ = (id) => document.getElementById(id);
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const now = () => performance.now() / 1000;

// ------------------------------------------------------------------ renderer, camera, controls
const host = $('scene');
export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
export const maxDpr = Math.min(devicePixelRatio, 2);
renderer.setPixelRatio(maxDpr);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // refreshed every other frame in the loop
host.appendChild(renderer.domElement);
export const labels = new CSS2DRenderer();
Object.assign(labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
host.appendChild(labels.domElement);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
// Map-style controls: drag to pan, right-drag (or two fingers) to turn, wheel or pinch to zoom, arrow keys pan.
export const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = 1.38;
controls.minDistance = 4;
controls.maxDistance = 120;
controls.screenSpacePanning = false;
controls.keyPanSpeed = 25;
controls.listenToKeyEvents(window);
const LIMIT = { x0: -48, x1: 70, z0: -24, z1: 24 };
controls.addEventListener('change', () => {
  // keep the camera over the campus: shift camera and target together when panning past the edge
  const t = controls.target;
  const cx = clamp(t.x, LIMIT.x0, LIMIT.x1) - t.x, cz = clamp(t.z, LIMIT.z0, LIMIT.z1) - t.z;
  if (cx || cz) { t.x += cx; t.z += cz; camera.position.x += cx; camera.position.z += cz; }
});

export function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ light (warm hemisphere + one sun)
const hemi = new THREE.HemisphereLight('#FFF6E8', '#B9D99A', 1.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#FFFFFF', 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -54, right: 54, top: 26, bottom: -26, near: 1, far: 170 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.target.position.set(13, 0, 0);
scene.add(sun, sun.target);

// ------------------------------------------------------------------ materials and primitives
const mats = new Map();
export function M(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts }));
  return mats.get(key);
}
const glass = new THREE.MeshStandardMaterial({ color: '#BFE6F5', transparent: true, opacity: 0.25, roughness: 0.1, depthWrite: false });

export const blockers = [];
export function blockRect(x, z, w, d, rot = 0) {
  const swap = Math.abs(Math.sin(rot)) > 0.5;
  const [bw, bd] = swap ? [d, w] : [w, d];
  blockers.push([x - bw / 2, z - bd / 2, x + bw / 2, z + bd / 2]);
}
export function box(w, h, d, mat, x, y, z, { rot = 0, block = false, parent = scene, shadow = true } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof mat === 'string' || typeof mat === 'number' ? M(mat) : mat);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = rot;
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  if (block) blockRect(x, z, w, d, rot);
  return m;
}
export function cyl(r, h, mat, x, y, z, { parent = scene, segs = 16, r2 = r, block = false } = {}) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, h, segs), typeof mat === 'object' ? mat : M(mat));
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  if (block) blockers.push([x - r, z - r, x + r, z + r]);
  return m;
}
export function sign(text, x, y, z, cls = 'sign') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  const o = new CSS2DObject(el);
  o.position.set(x, y, z);
  scene.add(o);
  return el;
}
/** Words painted flat on the floor, readable from the default (south) view. */
export function floorText(text, x, z, { w = 4, color = '#2A2420', alpha = 0.55, rot = 0, sub = '' } = {}) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = sub ? 300 : 220;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.globalAlpha = alpha;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 150;
  g.font = `900 ${size}px system-ui, -apple-system, sans-serif`;
  while (g.measureText(text).width > 980 && size > 40) g.font = `900 ${(size -= 6)}px system-ui, -apple-system, sans-serif`;
  g.fillText(text, 512, sub ? 120 : 110);
  if (sub) { g.font = '700 70px system-ui, -apple-system, sans-serif'; g.fillText(sub, 512, 240); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, (w * c.height) / c.width), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  m.rotation.set(-Math.PI / 2, 0, rot);
  m.position.set(x, 0.016, z);
  m.renderOrder = 2;
  scene.add(m);
  return { mesh: m, canvas: c, tex };
}

// ------------------------------------------------------------------ the home kit, instanced
// Every repeated piece (wall, post, window, floor tile, desk, chair, tree...) is one InstancedMesh per
// material, so the campus is ~150 draw calls however many desks it has.
export const kit = new Map();
export function loadKit(gltf) {
  gltf.scene.updateMatrixWorld(true);
  for (const root of gltf.scene.children) {
    const inv = root.matrixWorld.clone().invert(), parts = [];
    root.traverse((m) => {
      if (m.isMesh) parts.push({ geometry: m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)), material: m.material });
    });
    kit.set(root.name, parts);
  }
  // The kit's bevelled floor tile is 108 triangles; thousands of them dominate the frame. A plain inset slab
  // (12 triangles) keeps the grout lines at a tenth of the cost.
  const tint = kit.get('floor_tile')[0].material;
  kit.set('tile', [{ geometry: new THREE.BoxGeometry(0.47, 0.05, 0.47).translate(0, -0.025, 0), material: tint }]);
  kit.set('strip', [{ geometry: new THREE.BoxGeometry(1, 0.012, 1).translate(0, 0.006, 0), material: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, name: 'tint' }) }]);
}
const placements = new Map();
const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
/** Put a kit piece at (x, z) turned rot, optionally scaled and tinted (tint applies to `tintParts`). */
export function put(name, x, z, rot = 0, { y = 0, s = 1, sx = s, sy = s, sz = s, tint = null, tintParts = null, shadow = true, block = false } = {}) {
  if (!placements.has(name)) placements.set(name, []);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.setFromAxisAngle(_up, rot), new THREE.Vector3(sx, sy, sz));
  placements.get(name).push({ m, tint, tintParts, shadow });
  if (block) {
    const b = new THREE.Box3();
    for (const p of kit.get(name) || []) { p.geometry.computeBoundingBox(); b.union(p.geometry.boundingBox); }
    const c = b.getCenter(new THREE.Vector3()).multiply(new THREE.Vector3(sx, 1, sz)).applyAxisAngle(_up, rot);
    blockRect(x + c.x, z + c.z, (b.max.x - b.min.x) * sx, (b.max.z - b.min.z) * sz, rot);
  }
}
const tintable = new Set(['tint', 'sofa', 'cushion', 'seat', 'desk_top']);
function commitKit() {
  const white = new THREE.Color('#ffffff');
  for (const [name, list] of placements) {
    for (const part of kit.get(name) || []) {
      const hit = (p) => p.tint && (p.tintParts ? p.tintParts.includes(part.material.name) : tintable.has(part.material.name));
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      const tinted = list.some(hit);
      list.forEach((p, i) => {
        mesh.setMatrixAt(i, p.m);
        if (tinted) mesh.setColorAt(i, hit(p) ? new THREE.Color(p.tint) : white);
      });
      mesh.castShadow = list[0].shadow;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      scene.add(mesh);
    }
  }
  placements.clear();
}

// ------------------------------------------------------------------ navigation grid (0.5 m cells, A*)
const X0 = -46, Z0 = -19, CELL = 0.5, GW = 216, GH = 76;
const grid = new Uint8Array(GW * GH);
export const cellOf = (x, z) => [clamp(Math.floor((x - X0) / CELL), 0, GW - 1), clamp(Math.floor((z - Z0) / CELL), 0, GH - 1)];
export const centre = (i, j) => [X0 + (i + 0.5) * CELL, Z0 + (j + 0.5) * CELL];
export const blocked = (i, j) => i < 0 || j < 0 || i >= GW || j >= GH || grid[j * GW + i] === 1;
export const MAIN = { x0: -20, x1: 20, z0: -13, z1: 13 };
export const WLB = { x0: 31, x1: 61, z0: -11, z1: 9 };
export const TERM = { x0: 21.5, x1: 29.5, z0: 1, z1: 10 }; // the terminal annex between the two buildings
export const REC = { x0: -40, x1: -20, z0: -13, z1: 13 };  // the rec wing west of the main office, through its doors
export const ASSEMBLY = { x0: -10, x1: 2, z0: 12.6, z1: 17 }; // the lawn outside the front door: fire drills
let hqOn = false;
export const buildingOf = (x) => (x > 30.5 ? 'wl' : x > 20.5 ? 'term' : 'main');
function bakeGrid() {
  const PAD = 0.24;
  for (const [x0, z0, x1, z1] of blockers) {
    const [i0, j0] = cellOf(x0 - PAD, z0 - PAD), [i1, j1] = cellOf(x1 + PAD - 1e-6, z1 + PAD - 1e-6);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * GW + i] = 1;
  }
  const inside = (x, z, b) => x > b.x0 + 0.2 && x < b.x1 - 0.2 && z > b.z0 + 0.2 && z < b.z1 - 0.2;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const [x, z] = centre(i, j);
    if (!inside(x, z, MAIN) && !(hqOn && inside(x, z, WLB)) && !inside(x, z, TERM) && !inside(x, z, REC) && !inside(x, z, ASSEMBLY)) grid[j * GW + i] = 1; // staff stay indoors (and out on the lawn for drills)
  }
}
export function nearestFree(i, j) {
  if (!blocked(i, j)) return [i, j];
  for (let r = 1; r < 12; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) === r && !blocked(i + di, j + dj)) return [i + di, j + dj];
  }
  return [i, j];
}
function lineClear(ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 0.2);
  for (let k = 1; k < n; k++) {
    const [i, j] = cellOf(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
    if (blocked(i, j)) return false;
  }
  return true;
}
const G = new Float32Array(GW * GH), FROM = new Int32Array(GW * GH), CLOSED = new Uint8Array(GW * GH);
// ponytail: plain A* on a 176x76 grid (scratch arrays reused), a few ms worst case; add a path cache past ~200 walkers.
export function findPath(sx, sz, tx, tz) {
  const [si, sj] = nearestFree(...cellOf(sx, sz)), [ti, tj] = nearestFree(...cellOf(tx, tz));
  const start = sj * GW + si, goal = tj * GW + ti;
  G.fill(Infinity); FROM.fill(-1); CLOSED.fill(0);
  const heap = [[0, start]];
  G[start] = 0;
  const h = (k) => { const di = Math.abs((k % GW) - ti), dj = Math.abs(((k / GW) | 0) - tj); return Math.max(di, dj) + 0.414 * Math.min(di, dj); };
  const push = (item) => { heap.push(item); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
  while (heap.length) {
    const [, k] = pop();
    if (k === goal) break;
    if (CLOSED[k]) continue;
    CLOSED[k] = 1;
    const i = k % GW, j = (k / GW) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (blocked(ni, nj) || (di && dj && (blocked(i + di, j) || blocked(i, j + dj)))) continue;
      const nk = nj * GW + ni, cost = G[k] + (di && dj ? 1.414 : 1);
      if (cost < G[nk]) { G[nk] = cost; FROM[nk] = k; push([cost + h(nk), nk]); }
    }
  }
  const cells = [];
  for (let k = goal; k !== -1; k = FROM[k]) { cells.push(k); if (k === start) break; }
  if (cells.at(-1) !== start) return [[tx, tz]]; // unreachable: walk straight, better than freezing
  const pts = cells.reverse().map((k) => centre(k % GW, (k / GW) | 0));
  pts[pts.length - 1] = [tx, tz];
  const out = [];
  let a = [sx, sz];
  for (let k = 0; k < pts.length;) {
    let far = k;
    for (let m = pts.length - 1; m > k; m--) if (lineClear(a[0], a[1], pts[m][0], pts[m][1])) { far = m; break; }
    out.push(pts[far]);
    a = pts[far];
    k = far + 1;
  }
  return out;
}

// ------------------------------------------------------------------ spots: where characters sit and stand
export const faceTo = (dx, dz) => Math.atan2(dx, dz);
export const SEAT = 0.45;
export function spot(x, z, face, pose = 'stand', o = {}) { return { x, z, ax: o.ax ?? x, az: o.az ?? z, face, pose, seatY: o.seatY ?? SEAT, ...o }; }
const pools = () => ({
  coffee: [], vending: [], fridge: [], couch: [], table: [], pingpong: [], cooler: [], copier: [], window: [], conf: [], phone: [], lounge: [],
  pool: [], foosball: [], arcade: [], darts: [], treadmill: [], weights: [], yoga: [], beanbag: [], pod: [], lab: [],
});
export const spots = { main: pools(), wl: pools(), term: pools() };
export const layout = {
  desks: [], cowork: [], mcpOffices: [], sessions: [], boss: null, archive: null, reception: null, hrDesk: null, cand: [],
  wlOffices: [], wlFuture: {}, fair: {}, planSpots: [], clashSpots: [], assembly: [], lab: null, wlReception: null, pools: [], cabinets: [], exit: { main: null, wl: null, term: null }, terminals: [], waitSpots: [],
};

// ------------------------------------------------------------------ walls on the 0.5 m grid, like the Home Map
// Back walls stand full height with windows; everything else is cut away low, like a dollhouse.
const edges = new Map(); // "h:i:j" | "v:i:j" -> { kind: 'wall'|'window'|'door', full }
const ei = (x) => Math.round((x - X0) / CELL), ej = (z) => Math.round((z - Z0) / CELL);
function wallLine(x0, z0, x1, z1, { full = false, doors = [], windows = false } = {}) {
  const horiz = z0 === z1;
  const a0 = horiz ? ei(x0) : ej(z0), a1 = horiz ? ei(x1) : ej(z1);
  for (let a = Math.min(a0, a1); a < Math.max(a0, a1); a++) {
    const mid = (horiz ? X0 : Z0) + (a + 0.5) * CELL;
    const key = horiz ? `h:${a}:${ej(z0)}` : `v:${ei(x0)}:${a}`;
    const isDoor = doors.some(([d0, d1]) => mid > d0 && mid < d1);
    const prev = edges.get(key);
    if (prev?.kind === 'door') continue;
    const k = isDoor ? 'door' : prev ? prev.kind : windows && a % 6 !== 0 && a % 6 !== 5 ? 'window' : 'wall';
    edges.set(key, { kind: k, full: full || prev?.full || false });
  }
}
function room(x0, z0, x1, z1, doors = {}) {
  wallLine(x0, z0, x1, z0, { doors: doors.n || [] });
  wallLine(x0, z1, x1, z1, { doors: doors.s || [] });
  wallLine(x0, z0, x0, z1, { doors: doors.w || [] });
  wallLine(x1, z0, x1, z1, { doors: doors.e || [] });
}
function shell(b, door) {
  wallLine(b.x0, b.z0, b.x1, b.z0, { full: true, windows: true });
  wallLine(b.x0, b.z0, b.x0, b.z1, { full: true, windows: true });
  wallLine(b.x0, b.z1, b.x1, b.z1, { doors: [door], windows: true });
  wallLine(b.x1, b.z0, b.x1, b.z1, { windows: true });
}
function buildWalls() {
  const vert = new Map();
  const touch = (i, j, key) => { const k = `${i},${j}`; if (!vert.has(k)) vert.set(k, []); vert.get(k).push(key); };
  for (const [key, e] of edges) {
    const [o, a, b] = key.split(':');
    const i = Number(a), j = Number(b);
    const x = X0 + (o === 'h' ? i + 0.5 : i) * CELL, z = Z0 + (o === 'h' ? j : j + 0.5) * CELL;
    const rot = o === 'h' ? 0 : Math.PI / 2;
    if (e.kind === 'door') { put('door_lo', x, z, rot, { shadow: false }); if (e.full) put('door_hi', x, z, rot); continue; }
    put(`${e.kind}_lo`, x, z, rot);
    if (e.full) put(`${e.kind}_hi`, x, z, rot);
    blockRect(x, z, CELL, 0.16, rot);
    touch(i, j, key);
    touch(o === 'h' ? i + 1 : i, o === 'h' ? j : j + 1, key);
  }
  for (const [k, list] of vert) {
    const [i, j] = k.split(',').map(Number);
    const hs = list.filter((s) => s[0] === 'h').length, vs = list.length - hs;
    if (list.length === 2 && (hs === 2 || vs === 2)) continue; // straight run, no post
    const x = X0 + i * CELL, z = Z0 + j * CELL;
    put('post_lo', x, z);
    if (list.some((key) => edges.get(key).full)) put('post_hi', x, z);
  }
}

// ------------------------------------------------------------------ floors: a colour per room, outlined
export const ROOM_TINT = ['#F97316', '#0EA5E9', '#8B5CF6', '#16A34A', '#DB2777', '#D97706', '#0D9488', '#64748B'];
const CREAM = new THREE.Color('#FBF1E3');
const zones = [];
/** A floor zone: tiles take `tint` mixed into cream, and a darker band marks its edge. */
function zone(x0, z0, x1, z1, tint, { mix = 0.32, edge = true, label = null, labelW = null, sub = '', labelX = null, labelZ = null } = {}) {
  const color = tint ? CREAM.clone().lerp(new THREE.Color(tint), mix) : CREAM.clone();
  zones.push({ x0, z0, x1, z1, color });
  if (edge) {
    const line = new THREE.Color(tint || '#B8A68E').lerp(new THREE.Color('#2A2420'), 0.25).getStyle(), W = 0.1, i = 0.12;
    put('strip', (x0 + x1) / 2, z0 + i, 0, { sx: x1 - x0 - 2 * i, sz: W, tint: line, tintParts: ['tint'], shadow: false });
    put('strip', (x0 + x1) / 2, z1 - i, 0, { sx: x1 - x0 - 2 * i, sz: W, tint: line, tintParts: ['tint'], shadow: false });
    put('strip', x0 + i, (z0 + z1) / 2, 0, { sx: W, sz: z1 - z0 - 2 * i, tint: line, tintParts: ['tint'], shadow: false });
    put('strip', x1 - i, (z0 + z1) / 2, 0, { sx: W, sz: z1 - z0 - 2 * i, tint: line, tintParts: ['tint'], shadow: false });
  }
  if (label) {
    const dark = new THREE.Color(tint || '#8B7355').lerp(new THREE.Color('#1C1108'), 0.45).getStyle();
    floorText(label, labelX ?? (x0 + x1) / 2, labelZ ?? z1 - Math.min(1.1, (z1 - z0) * 0.22), { w: labelW || Math.min(x1 - x0 - 0.8, 6), color: dark, alpha: 0.5, sub });
  }
}
function buildFloor(b) {
  for (let z = b.z0 + CELL / 2; z < b.z1; z += CELL) for (let x = b.x0 + CELL / 2; x < b.x1; x += CELL) {
    const zn = [...zones].reverse().find((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
    put('tile', x, z, 0, { tint: (zn?.color || CREAM).getStyle(), tintParts: ['tint'], shadow: false });
  }
  box(b.x1 - b.x0, 0.05, b.z1 - b.z0, '#D9CCB8', (b.x0 + b.x1) / 2, -0.055, (b.z0 + b.z1) / 2, { shadow: false }); // grout
}

// ------------------------------------------------------------------ furniture
const codeCanvas = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1117'; g.fillRect(0, 0, 128, 256);
  const cols = ['#79c0ff', '#ff7b72', '#d2a8ff', '#7ee787', '#e6edf3', '#ffa657'];
  for (let y = 4; y < 252; y += 9) {
    let x = 6 + 8 * Math.floor(Math.random() * 4);
    for (let s = 0; s < 1 + Math.random() * 4 && x < 118; s++) {
      const w = 6 + Math.random() * 30;
      g.fillStyle = pick(cols); g.fillRect(x, y, Math.min(w, 122 - x), 4);
      x += w + 4;
    }
  }
  return c;
})();
export const screens = [];
const screenGeo = new THREE.PlaneGeometry(0.55, 0.29), laptopGeo = new THREE.PlaneGeometry(0.3, 0.18);
function codeScreen(geo, x, y, z, rot, tiltX = 0) {
  const tex = new THREE.CanvasTexture(codeCanvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.offset.y = Math.random();
  const scr = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  scr.position.set(x, y, z);
  scr.rotation.set(tiltX, rot, 0, 'YXZ');
  scr.visible = false;
  scene.add(scr);
  const s = { mesh: scr, tex };
  screens.push(s);
  return s;
}
/** A kit desk with PC and chair. The desk's front (+z) faces the chair; `rot` turns the pair. Returns the seat. */
function desk(x, z, rot, { pc = true, chairTint = null } = {}) {
  put(pc ? 'dev_desktop_pc' : 'dev_monitor', x, z, rot, { block: true });
  const fx = Math.sin(rot), fz = Math.cos(rot);
  const cx = x + fx * 0.75, cz = z + fz * 0.75;
  put('dev_chair', cx, cz, rot + Math.PI, { tint: chairTint, tintParts: ['seat'] });
  const s = spot(cx, cz, rot + Math.PI, 'sit');
  s.screen = codeScreen(screenGeo, x - fx * 0.075, 1.05, z - fz * 0.075, rot);
  return s;
}
function plant(x, z, s = 1, kind = 'bush') {
  cyl(0.2 * s, 0.38 * s, '#C97B4A', x, 0, z, { block: true, segs: 12, r2: 0.24 * s });
  put(kind, x, z, Math.random() * 6, { y: 0.36 * s, s: s * (kind === 'bush' ? 0.8 : 0.55) });
}
function chairAt(x, z, face, list, opts = {}) {
  put('dev_chair', x, z, face, opts);
  const s = spot(x, z, face, 'sit');
  list.push(s);
  return s;
}

// ------------------------------------------------------------------ the KL skyline beyond the north windows
export const cityLights = [];
function buildSkyline() {
  const winCanvas = document.createElement('canvas');
  winCanvas.width = 64; winCanvas.height = 256;
  const g = winCanvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 256);
  for (let y = 2; y < 256; y += 6) for (let x = 2; x < 64; x += 6) if (Math.random() < 0.55) { g.fillStyle = pick(['#ffd27a', '#ffe9b0', '#fff4d6']); g.fillRect(x, y, 3, 3); }
  const lit = (color, rx = 1, ry = 1) => {
    const t = new THREE.CanvasTexture(winCanvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.5, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0 });
    cityLights.push(m);
    return m;
  };
  const steel = lit('#c9d1d9', 2, 1);
  const tower = (x, z) => {
    let y = 0;
    for (const [r, h] of [[3.2, 16], [2.9, 9], [2.5, 7], [2.1, 5], [1.7, 4], [1.3, 3], [0.9, 2.5]]) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.94, r, h, 8), steel);
      m.position.set(x, y + h / 2, z);
      scene.add(m);
      y += h;
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.35, 10, 8), M('#dfe6ec', { metalness: 0.8, roughness: 0.3 }));
    spire.position.set(x, y + 5, z);
    scene.add(spire);
  };
  tower(10, -80); tower(22, -80);
  box(9, 1.2, 1.2, steel, 16, 22, -80, { shadow: false });
  const kl = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, 34, 12), M('#d6dbe0'));
  kl.position.set(-26, 17, -86); scene.add(kl);
  const pod = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 10), lit('#a9c7d8', 4, 1));
  pod.scale.y = 0.7; pod.position.set(-26, 35, -86); scene.add(pod);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.3, 10, 6), M('#e74c3c'));
  mast.position.set(-26, 42, -86); scene.add(mast);
  for (let k = 0; k < 26; k++) {
    const x = -70 + k * 6.5 + rand(-1.5, 1.5);
    if (x > 4 && x < 28) continue;
    const h = rand(8, 26), w = rand(4, 7);
    box(w, h, rand(4, 7), lit(pick(['#9aa7b4', '#b7a99a', '#8d9aa8', '#c4c9ce']), 2, Math.ceil(h / 8)), x, 0, rand(-72, -96), { shadow: false });
  }
}

// ------------------------------------------------------------------ warm light pools on the floor after dark (Home Map trick)
let poolMesh;
const bulbMats = [];
function buildPools() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.55, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const geo = new THREE.PlaneGeometry(3.2, 3.2).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: '#FFC46B', map: new THREE.CanvasTexture(c), transparent: true, opacity: 0, depthWrite: false });
  poolMesh = new THREE.InstancedMesh(geo, mat, layout.pools.length);
  layout.pools.forEach(([x, z], i) => poolMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0.012, z)));
  poolMesh.renderOrder = 1;
  scene.add(poolMesh);
  scene.traverse((o) => { if (o.isInstancedMesh && o.material.name === 'bulb') bulbMats.push(o.material); });
}

// ------------------------------------------------------------------ boards: the campus lawn
function site() {
  const bx0 = REC.x0 - 4, bx1 = (hqOn ? WLB.x1 : TERM.x1) + 4, bz0 = MAIN.z0 - 4, bz1 = MAIN.z1 + 5;
  box(bx1 - bx0, 0.6, bz1 - bz0, '#D3A77A', (bx0 + bx1) / 2, -0.62, (bz0 + bz1) / 2, { shadow: false });
  box(bx1 - bx0, 0.02, bz1 - bz0, '#BFE3A0', (bx0 + bx1) / 2, -0.03, (bz0 + bz1) / 2, { shadow: false });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2), M('#9CC57F'));
  ground.position.y = -0.64; ground.receiveShadow = true; scene.add(ground);
  const gates = hqOn ? [[-5, -3.5], [34.5, 36]] : [[-5, -3.5]];
  for (let x = bx0 + 0.45; x < bx1 - 0.2; x += 0.5) {
    put('fence', x, bz0 + 0.2, 0);
    if (!gates.some(([a, b]) => x > a - 0.1 && x < b + 0.1)) put('fence', x, bz1 - 0.2, Math.PI);
  }
  for (let z = bz0 + 0.45; z < bz1 - 0.2; z += 0.5) { put('fence', bx0 + 0.2, z, -Math.PI / 2); put('fence', bx1 - 0.2, z, Math.PI / 2); }
  // paths from the gates to the doors, and one between the two buildings
  for (const [g0, g1, zStart] of [[-5, -3.5, MAIN.z1], ...(hqOn ? [[34.5, 36, WLB.z1]] : [])]) for (let z = zStart + 0.25; z < bz1 - 0.2; z += 0.5) for (let x = g0 + 0.25; x < g1; x += 0.5) put('tile', x, z, 0, { tint: '#DAD5CC', tintParts: ['tint'], shadow: false });
  for (let x = MAIN.x1 + 0.25; x < (hqOn ? WLB.x0 : TERM.x1); x += 0.5) for (const z of [11.75, 12.25]) put('tile', x, z, 0, { tint: '#DAD5CC', tintParts: ['tint'], shadow: false });
  // staff parking between the buildings: two cars and the kapcai
  put('dev_car', 23.2, -7, 0); put('dev_car', 27.3, -7, Math.PI); put('dev_motorcycle', 22.6, -2.2, 0.2); put('dev_motorcycle', 23.4, -1.9, -0.15);
  for (let z = TERM.z1 + 0.25; z < 11.5; z += 0.5) for (const x of [25.25, 25.75]) put('tile', x, z, 0, { tint: '#DAD5CC', tintParts: ['tint'], shadow: false });
  const trees = [[-22, -15.5], [-17, -16], [-9, -16.2], [-2, -15.8], [6, -16.1], [14, -15.6], [22.5, -15.5], [29, -15.6], [38, -14.5], [46, -15], [55, -14.6], [63.6, -8], [63.8, 1], [63.4, 10], [61, -14.8],
    [-42.5, -6], [-42.2, 3], [-42.6, 11], [-42.4, -15.5], [26, -3], [28.6, -12], [-21, 15.8], [-12, 15.6], [2, 16], [12, 16.2], [20.5, 16.2], [29, 16], [44, 15.4], [52, 16]];
  trees.filter(([x]) => x < bx1 - 1).forEach(([x, z], k) => put(['tree_round', 'tree_pine', 'bush', 'tree_round'][k % 4], x, z, k * 1.7, { s: k % 4 === 2 ? 1.6 : 1.25 + (k % 3) * 0.15 }));
}

// ------------------------------------------------------------------ the main office (Clawd Mifflin)
function buildMain({ mcpCount, podCount, mcpTints }) {
  shell(MAIN, [-5, -3.5]);
  // doors west into the rec wing: from the break room, the conference room and Claude's office
  wallLine(MAIN.x0, MAIN.z0, MAIN.x0, MAIN.z1, { full: true, doors: [[-11.6, -10.6], [2.6, 3.6], [7.6, 8.6]] });
  room(-20, 4, -13, 13, { e: [[7.5, 8.5]] });               // Claude's office, next to reception
  room(-20, -4, -13, 4, { e: [[1, 2]] });                    // conference room (interns work here)
  room(-20, -13, -7, -4, { s: [[-12, -10]] });              // break room
  room(-7, -13, -1, -6, { s: [[-4.5, -3.5]] });              // records (memory)
  room(-1, -13, 8, -6, { s: [[6.5, 7.5]] });                 // HR annex
  zone(-13, -6, 8, 13, '#E0B26B', { mix: 0.18, edge: false });                       // bullpen floor
  zone(-12.6, -3.2, 2.6, 9.6, '#E0B26B', { mix: 0.22, label: 'BULLPEN', labelW: 5, sub: 'Claude family desks' });
  zone(3.5, -2, 6.6, 4.3, '#DB2777', { mix: 0.3, label: 'CO-WORKING', labelW: 2.8, sub: 'partners' });
  zone(6, 5.4, 8, 9.6, '#16A34A', { mix: 0.3 });
  zone(-9.8, 9.8, -3, 12.8, '#D97706', { mix: 0.3, label: 'RECEPTION', labelW: 3.6 });
  zone(-20, 4, -13, 13, ROOM_TINT[0], { label: "CLAUDE'S OFFICE", labelW: 5, labelZ: 5.3 });
  zone(-20, -4, -13, 4, ROOM_TINT[1], { label: 'CONFERENCE', labelW: 5, sub: 'interns work here' });
  zone(-20, -13, -7, -4, ROOM_TINT[6], { label: 'BREAK ROOM', labelW: 4, labelX: -15.2, labelZ: -5.2 });
  zone(-7, -13, -1, -6, ROOM_TINT[7], { label: 'RECORDS', labelW: 4, sub: 'memory' });
  zone(-1, -13, 8, -6, ROOM_TINT[2], { label: 'HR', labelW: 3, sub: "this week's picks" });

  // MCP wing: corridor down the middle, a private office per server (tinted its company colour), lobby south
  const per = Math.max(1, Math.ceil(mcpCount / 2)), top = -13, bottom = 9.5, D = (bottom - top) / per;
  wallLine(8, -13, 8, bottom);
  zone(12.5, -13, 15.5, bottom, '#64748B', { mix: 0.3 });
  zone(8, bottom, 20, 13, '#0EA5E9', { mix: 0.18, label: 'MCP WING', labelW: 4.5, labelZ: 10.6 });
  let n = 0;
  for (let col = 0; col < 2; col++) {
    const [ox0, ox1, cx] = col === 0 ? [8, 12.5, 12.5] : [15.5, 20, 15.5];
    for (let k = 0; k < per; k++) {
      const z0 = top + k * D, z1 = z0 + D, zc = (z0 + z1) / 2;
      const dz = Math.round(zc * 2) / 2;
      wallLine(cx, z0, cx, z1, { doors: [[dz - 0.5, dz + 0.5]] });
      wallLine(ox0, z1, ox1, z1);
      const tint = mcpTints[n++] || '#94A3B8';
      zone(ox0, z0, ox1, z1, tint, { mix: 0.3 });
      const mx = (ox0 + ox1) / 2;
      const seat = desk(mx, z1 - 0.85, Math.PI);
      put('dev_router', col === 0 ? ox0 + 0.45 : ox1 - 0.45, z1 - 0.6, 0, { block: true });
      plant(col === 0 ? ox0 + 0.5 : ox1 - 0.5, z0 + 0.55, 0.75);
      layout.pools.push([mx, zc]);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(ox1 - ox0 - 0.4, D - 0.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
      glow.position.set(mx, 0.014, zc);
      scene.add(glow);
      layout.mcpOffices.push({ seat, glow, x: mx, z: z0 + 1.0, w: ox1 - ox0 - 1 });
    }
  }
  put('dev_sofa', 14, 12.35, Math.PI, { tint: '#3B82D6', tintParts: ['cushion'] });
  spots.main.lounge.push(...[-0.5, 0.5].map((d) => spot(14 + d, 12.1, Math.PI, 'sit', { ax: 14 + d, az: 11.3 })));
  plant(9, 12.2); plant(19.2, 12.2, 1, 'tree_round');

  // bullpen: pods of six desks for Claude's own tools and Anthropic plugins
  const pods = [[-9.7, -1.4], [-4.8, -1.4], [0.1, -1.4], [-9.7, 3.6], [-4.8, 3.6], [0.1, 3.6], [-4.8, 8.2], [0.1, 8.2]];
  for (const [xc, zc] of pods.slice(0, podCount)) {
    box(3.3, 1.05, 0.04, '#E6C49B', xc, 0, zc);
    for (let i = -1; i <= 1; i++) {
      layout.desks.push(desk(xc + i * 1.1, zc - 0.29, Math.PI, { pc: i !== 0 }));
      layout.desks.push(desk(xc + i * 1.1, zc + 0.29, 0, { pc: i === 0 }));
    }
    layout.pools.push([xc - 1.1, zc], [xc + 1.1, zc]);
  }
  // co-working table: partners from other companies share it, laptops out
  box(1.4, 0.74, 4.6, '#F2E4CF', 4.9, 0, 1.1, { block: true });
  for (let k = 0; k < 5; k++) {
    const z = -0.9 + k;
    for (const side of [-1, 1]) {
      const x = 4.9 + side * 1.2;
      const s = chairAt(x, z, side < 0 ? Math.PI / 2 : -Math.PI / 2, layout.cowork, { tint: '#DB2777', tintParts: ['seat'] });
      const lx = 4.9 + side * 0.42;
      box(0.32, 0.015, 0.22, '#C9CED6', lx, 0.74, z);
      const lid = box(0.32, 0.2, 0.012, '#C9CED6', lx + side * 0.1, 0.75, z, { rot: Math.PI / 2 });
      lid.rotation.z = side * 0.25;
      s.screen = codeScreen(laptopGeo, lx + side * 0.09, 0.86, z, side < 0 ? Math.PI / 2 : -Math.PI / 2);
    }
  }
  layout.pools.push([4.9, 0], [4.9, 2.4]);

  // phone booths at the edge of the bullpen, close to the desks
  for (const z of [6.4, 8.5]) {
    const x = 7.1;
    box(1.4, 2.2, 0.06, glass, x, 0, z - 0.75, { block: true, shadow: false });
    box(1.4, 2.2, 0.06, glass, x, 0, z + 0.75, { block: true, shadow: false });
    box(1.4, 0.08, 1.56, '#E6C49B', x, 2.2, z);
    box(0.5, 0.75, 0.04, '#D97757', x + 0.6, 0, z, { rot: Math.PI / 2 });
    spots.main.phone.push(spot(x + 0.1, z, -Math.PI / 2, 'stand', { ax: x - 0.75, az: z }));
  }
  put('dev_dispenser', -6.55, -5.55, 0, { block: true });
  spots.main.cooler.push(spot(-6.55, -4.75, Math.PI), spot(-5.75, -5.2, -Math.PI / 2 - 0.4));
  put('dev_printer', 7.5, -5.5, 0, { block: true });
  spots.main.copier.push(spot(7.5, -4.75, Math.PI));
  for (const [x, z, k] of [[-12.5, -3.5, 'tree_round'], [7.4, 12.4, 'tree_round'], [-12.5, 12.4, 'bush'], [7.4, -3.4, 'bush'], [-1.5, 10.6, 'bush']]) plant(x, z, 1, k);
  for (let x = -11.5; x <= 7; x += 2.5) if (x < -5.4 || x > -3) spots.main.window.push(spot(x, 12.45, 0));
  layout.exit.main = spot(-4.25, 12.5, Math.PI);

  // reception: an L of counters, Pam's candy jar, a waiting sofa
  for (let x = -8.75; x <= -6.25; x += 0.5) put('counter', x, 10.55, 0, { block: true });
  put('counter', -9.25, 10.55, Math.PI / 2, { block: true });
  box(0.5, 0.3, 0.03, '#1b1f2a', -7.6, 1.0, 10.45);
  box(0.06, 0.12, 0.06, '#1b1f2a', -7.6, 0.9, 10.5);
  const jar = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshStandardMaterial({ color: '#cde8ff', transparent: true, opacity: 0.55, roughness: 0.1 }));
  jar.position.set(-6.5, 1.02, 10.6); scene.add(jar);
  put('dev_chair', -7.6, 9.85, Math.PI);
  layout.reception = spot(-7.6, 9.85, 0, 'sit');
  put('dev_sofa', -1.5, 12.45, Math.PI, { tint: '#F97316', tintParts: ['cushion'] });
  spots.main.lounge.push(...[-0.5, 0.5].map((d) => spot(-1.5 + d, 12.2, Math.PI, 'sit', { ax: -1.5 + d, az: 11.4 })));
  layout.pools.push([-7.6, 10.5], [-1.5, 11.6]);

  // Claude's office: the boss desk plus two more for extra sessions
  layout.boss = desk(-16.5, 8.2, Math.PI, { chairTint: '#1F1F1F' });
  plant(-16.5, 11.9, 1.1, 'tree_round');
  put('dev_sofa', -19.3, 10.8, Math.PI / 2, { tint: '#8B5A2B', tintParts: ['sofa'] });
  spots.main.couch.push(spot(-19.1, 10.3, Math.PI / 2, 'sit', { ax: -18.3, az: 10.3 }), spot(-19.1, 11.3, Math.PI / 2, 'sit', { ax: -18.3, az: 11.3 }));
  box(0.4, 1.9, 2.4, '#8C5A35', -19.7, 0, 6.2, { block: true });
  for (let k = 0; k < 7; k++) box(0.25, 0.32, 0.12, pick(['#c0392b', '#2980b9', '#27ae60', '#f1c40f']), -19.6, 1.25, 5.3 + k * 0.3);
  put('dev_aircon', -19.92, 9, Math.PI / 2);
  put('dev_standing_fan', -13.6, 4.6, -Math.PI * 0.75, { block: true });
  cyl(0.05, 0.1, '#fff', -16.05, 0.75, 8.15, { segs: 10 }); // World's Best Boss mug
  layout.pools.push([-16.5, 7.5], [-15.8, 11]);

  // conference room: the table where interns (subagents) work
  box(1.4, 0.74, 4.2, '#E07D3B', -16.5, 0, 0, { block: true });
  for (const z of [-1.4, 0, 1.4]) { chairAt(-17.75, z, Math.PI / 2, spots.main.conf); chairAt(-15.25, z, -Math.PI / 2, spots.main.conf); }
  chairAt(-16.5, -2.75, 0, spots.main.conf); // head of the table, last: Claude's seat for meetings
  put('dev_tv_wall', -19.92, 0, Math.PI / 2);
  put('dev_aircon', -19.92, -2.6, Math.PI / 2);
  layout.pools.push([-16.5, -1], [-16.5, 1.5]);

  // break room
  for (let x = -19.7; x <= -16.7; x += 0.5) put('counter', x, -12.6, 0, { block: true });
  put('dev_coffee', -16.05, -12.6, 0, { block: true });
  put('dev_microwave', -15.4, -12.6, 0, { block: true });
  put('dev_kettle', -14.75, -12.6, 0, { block: true });
  put('dev_fridge', -13.9, -12.55, 0, { block: true });
  spots.main.coffee.push(spot(-16.05, -11.75, Math.PI), spot(-15.4, -11.75, Math.PI));
  spots.main.fridge.push(spot(-13.9, -11.6, Math.PI));
  box(1, 1.9, 0.8, '#C0392B', -8.2, 0, -12.5, { block: true });
  box(0.7, 1.1, 0.04, '#FFE9A8', -8.2, 0.6, -12.08);
  spots.main.vending.push(spot(-8.2, -11.55, Math.PI));
  put('dev_tv', -19.65, -8.2, Math.PI / 2, { block: true });
  put('dev_sofa', -17, -8.2, -Math.PI / 2, { tint: '#0D9488', tintParts: ['cushion'], block: true });
  for (const d of [-0.5, 0.5]) spots.main.couch.push(spot(-17.05, -8.2 + d, -Math.PI / 2, 'sit', { ax: -16.1, az: -8.2 + d }));
  cyl(0.6, 0.74, '#F2E4CF', -12.4, 0, -8.6, { block: true, segs: 24 });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4, x = -12.4 + Math.cos(a) * 1.05, z = -8.6 + Math.sin(a) * 1.05;
    chairAt(x, z, faceTo(-Math.cos(a), -Math.sin(a)), spots.main.table);
  }
  box(2.74, 0.05, 1.52, '#1E6F50', -10.2, 0.72, -5.7);
  box(0.03, 0.15, 1.6, '#fff', -10.2, 0.77, -5.7);
  for (const [lx, lz] of [[-1.2, -0.6], [1.2, -0.6], [-1.2, 0.6], [1.2, 0.6]]) box(0.06, 0.72, 0.06, '#333', -10.2 + lx, 0, -5.7 + lz);
  blockers.push([-11.57, -6.46, -8.83, -4.94]);
  spots.main.pingpong.push(spot(-12.45, -5.7, Math.PI / 2), spot(-7.95, -5.7, -Math.PI / 2));
  put('dev_aircon', -19.92, -11, Math.PI / 2);
  plant(-19.4, -4.6, 1, 'tree_round');
  layout.pools.push([-17.5, -11], [-12.4, -8.6], [-10.2, -5.7], [-17.5, -7.5]);

  // records room (memory)
  layout.archive = desk(-4, -8.6, Math.PI);
  for (let k = 0; k < 7; k++) {
    const x = -6.45 + k * 0.82;
    box(0.78, 1.35, 0.6, '#8D969E', x, 0, -12.55, { block: true });
    for (let d = 0; d < 3; d++) box(0.6, 0.32, 0.04, '#B6BEC5', x, 0.15 + d * 0.4, -12.24);
    layout.cabinets.push(x);
  }
  put('dev_wall_light', -4, -12.92, 0);
  layout.pools.push([-4, -10]);

  // HR annex: Toby's desk and the candidates' chairs
  layout.hrDesk = desk(5.6, -8.6, Math.PI, { chairTint: '#8B5CF6' });
  for (let k = 0; k < 8; k++) {
    const x = -0.3 + (k % 4) * 1.3, z = -12 + Math.floor(k / 4) * 1.75;
    put('dev_chair', x, z, Math.PI / 2, { tint: '#8B5CF6', tintParts: ['seat'] });
    layout.cand.push(spot(x, z, Math.PI / 2, 'sit'));
  }
  box(3.2, 1.3, 0.05, '#FFFFFF', 5, 1.0, -12.85);
  put('dev_purifier', 7.5, -12.5, 0, { block: true });
  plant(7.4, -6.6, 0.9, 'tree_round');
  layout.pools.push([1.2, -10.6], [5.6, -9.5]);

  // wall lights and aircons on the back walls
  for (let x = -18; x <= 18; x += 6) put('dev_wall_light', x, MAIN.z0 + 0.08, 0);
  for (let z = -10; z <= 10; z += 7) put('dev_wall_light', MAIN.x0 + 0.08, z, Math.PI / 2);
  for (const x of [-10.5, 3.5, 17.8]) put('dev_aircon', x, MAIN.z0 + 0.1, 0);
}

// ------------------------------------------------------------------ the HQ next door (private/hq.json)
// One office per feature of your own project, a lobby, vacant rooms for the teams it needs next, and an HR wing.
// Built only when the state carries the HQ config: the Mac's own page or the unlocked live view.
function buildWL({ features, future, hr = [], name, short, color: WL_BLUE }) {
  const opts = { hr };
  shell(WLB, [35, 37]);
  const WX = 55; // offices end here; the HR wing takes the east end
  const N = 6, nw = (WX - WLB.x0) / N, sw = (WX - 33) / N;
  zone(WLB.x0, -4.5, WX, -2, '#64748B', { mix: 0.28, edge: false });
  zone(WLB.x0, -2, 33, 4.5, '#64748B', { mix: 0.28, edge: false });
  zone(WLB.x0, 4.5, 41, WLB.z1, WL_BLUE, { mix: 0.22, label: `${name.toUpperCase()} HQ`, labelW: 5, sub: 'lobby', labelX: 36.8, labelZ: 5.4 });
  features.forEach((f, k) => {
    const north = k < N, c = north ? k : k - N;
    const x0 = north ? WLB.x0 + c * nw : 33 + c * sw, x1 = x0 + (north ? nw : sw);
    const z0 = north ? WLB.z0 : -2, z1 = north ? -4.5 : 4.5;
    const doorX = north ? x1 - 0.9 : (x0 + x1) / 2;
    room(x0, z0, x1, z1, north ? { s: [[doorX - 0.5, doorX + 0.5]] } : { n: [[doorX - 0.5, doorX + 0.5]] });
    zone(x0, z0, x1, z1, ROOM_TINT[k % ROOM_TINT.length], { mix: 0.3, label: f.name.toUpperCase(), labelW: Math.min(3.4, x1 - x0 - 0.5), labelZ: north ? z1 - 1.0 : z0 + 1.0 });
    const dx = north ? x0 + 1.6 : (x0 + x1) / 2 - 0.4;
    const seat = desk(dx, north ? -4.5 - 1.8 : 3.55, Math.PI, { chairTint: WL_BLUE });
    plant(north ? x0 + 0.5 : x1 - 0.5, z0 + 0.5, 0.7);
    if (k % 3 === 0) put('dev_standing_fan', x1 - 0.5, z0 + 0.55, -0.6, { block: true });
    layout.pools.push([(x0 + x1) / 2, (z0 + z1) / 2]);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 0.4, z1 - z0 - 0.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#FF6B2C', transparent: true, opacity: 0, depthWrite: false }));
    glow.position.set((x0 + x1) / 2, 0.013, (z0 + z1) / 2);
    scene.add(glow);
    layout.wlOffices.push({ seat, feature: f, glow });
  });
  // vacant rooms, hiring
  const fr = [[41, 48], [48, 55]];
  future.forEach((f, k) => {
    const [x0, x1] = fr[k];
    room(x0, 4.5, x1, WLB.z1, { w: [[6, 7]] });
    zone(x0, 4.5, x1, WLB.z1, '#94A3B8', { mix: 0.3, label: f.name.toUpperCase(), labelW: 4.4, sub: 'now hiring' });
    layout.wlFuture[f.id] = [0, 1, 2].map((i) => {
      const x = x0 + 1.6 + i * 1.6;
      put('dev_chair', x, 6.1, 0, { tint: '#94A3B8', tintParts: ['seat'] });
      return spot(x, 6.1, 0, 'sit');
    });
    box(2.2, 1.2, 0.05, '#FFFFFF', (x0 + x1) / 2, 0.9, 4.62);
    layout.pools.push([(x0 + x1) / 2, 6.8]);
  });
  // HR wing: this week's plugins, MCP servers and repos for the app, one section each
  room(WX, WLB.z0, WLB.x1, WLB.z1, { w: [[-4.5, -2]] });
  zone(WX, WLB.z0, WLB.x1, WLB.z1, '#C026D3', { mix: 0.12, edge: false });
  const sect = [[WLB.z0, -4.5], [-4.5, 2.5], [2.5, WLB.z1]];
  (opts.hr || []).forEach((r, k) => {
    const [z0, z1] = sect[k];
    zone(WX, z0, WLB.x1, z1, ['#C026D3', '#7C3AED', '#0EA5E9'][k], { mix: 0.26, label: r.name.toUpperCase(), labelW: 4.2, sub: k === 0 ? `${short} HR` : 'this week', labelZ: z1 - 0.9 });
    const zc = (z0 + z1) / 2 - 0.6;
    layout.wlFuture[r.id] = [[57, zc - 0.9], [59.4, zc - 0.9], [57, zc + 0.9], [59.4, zc + 0.9]].map(([x, z]) => {
      put('dev_chair', x, z, 0, { tint: '#C026D3', tintParts: ['seat'] });
      return spot(x, z, 0, 'sit');
    });
    layout.pools.push([58.2, zc]);
  });
  put('dev_coffee', WLB.x1 - 0.45, -3.25, -Math.PI / 2, { block: true });
  spots.wl.coffee.push(spot(WLB.x1 - 1.3, -3.25, Math.PI / 2));
  plant(WLB.x1 - 0.6, WLB.z1 - 0.6, 1, 'tree_round');

  // lobby: reception, coffee, water, sofa
  for (let x = 32.25; x <= 34.25; x += 0.5) put('counter', x, 6.4, 0, { block: true });
  put('dev_chair', 33.25, 5.7, Math.PI);
  layout.wlReception = spot(33.25, 5.7, 0, 'sit');
  put('dev_coffee', 40.55, 5.1, -Math.PI / 2, { block: true });
  spots.wl.coffee.push(spot(39.7, 5.1, Math.PI / 2));
  put('dev_dispenser', 40.6, 7.85, -Math.PI / 2, { block: true });
  spots.wl.cooler.push(spot(39.8, 7.85, Math.PI / 2), spot(39.6, 7.05, Math.PI / 2 + 0.5));
  put('dev_sofa', 37.5, 8.45, Math.PI, { tint: WL_BLUE, tintParts: ['cushion'] });
  spots.wl.lounge.push(...[-0.5, 0.5].map((d) => spot(37.5 + d, 8.2, Math.PI, 'sit', { ax: 37.5 + d, az: 7.4 })));
  for (let x = 32; x <= 39; x += 2.3) spots.wl.window.push(spot(x, 8.45, 0));
  plant(31.6, 8.4, 1, 'tree_round');
  layout.exit.wl = spot(35.75, 8.5, Math.PI);
  layout.pools.push([33.3, 6], [37.5, 7.5]);
  for (let x = 33; x <= 58; x += 5) put('dev_wall_light', x, WLB.z0 + 0.08, 0);
  for (const z of [-7, 1, 6]) put('dev_wall_light', WLB.x0 + 0.08, z, Math.PI / 2);
  for (const x of [36, 47]) put('dev_aircon', x, WLB.z0 + 0.1, 0);
  // the logo, on the lawn: the "Wah!" sign
  floorText(name.toUpperCase(), 43, 11.6, { w: 10, color: WL_BLUE, alpha: 0.85 });
}

// ------------------------------------------------------------------ the terminal annex: one desk per Claude Code session
function buildTerminals() {
  shell(TERM, [25, 26]);
  zone(TERM.x0, TERM.z0, TERM.x1, TERM.z1, '#1E293B', { mix: 0.3, label: 'TERMINALS', labelW: 3.6, sub: 'one desk per session', labelZ: 8.3 });
  const at = [[23.3, 2.2], [25.5, 2.2], [27.7, 2.2], [24.4, 5.2], [26.6, 5.2]];
  layout.terminals = at.map(([x, z], k) => {
    const s = desk(x, z, 0, { chairTint: '#D97757' });
    floorText(`T${k + 1}`, x + 0.85, z + 1.2, { w: 0.9, color: '#D97757', alpha: 0.9 });
    return s;
  });
  put('dev_coffee', TERM.x1 - 0.45, 8.6, -Math.PI / 2, { block: true });
  spots.term.coffee.push(spot(TERM.x1 - 1.3, 8.6, Math.PI / 2));
  put('dev_sofa', TERM.x0 + 0.5, 7.6, Math.PI / 2, { tint: '#D97757', tintParts: ['cushion'] });
  spots.term.lounge.push(...[-0.5, 0.5].map((d) => spot(TERM.x0 + 0.7, 7.6 + d, Math.PI / 2, 'sit', { ax: TERM.x0 + 1.5, az: 7.6 + d })));
  for (const x of [23, 25.5, 28]) spots.term.window.push(spot(x, TERM.z0 + 0.45, Math.PI));
  plant(TERM.x1 - 0.5, TERM.z0 + 0.5, 0.8);
  put('dev_aircon', 25.5, TERM.z0 + 0.1, 0);
  put('dev_wall_light', TERM.x0 + 0.08, 4, Math.PI / 2);
  layout.exit.term = spot(25.5, TERM.z1 - 0.4, Math.PI);
  // the plan-mode whiteboard: a session in plan mode stands here sketching
  box(0.08, 1.0, 1.7, '#ffffff', 21.85, 1.0, 4.3, { block: true });
  box(0.05, 1.0, 0.05, '#555', 21.85, 0, 3.5); box(0.05, 1.0, 0.05, '#555', 21.85, 0, 5.1);
  for (const [k, c] of [[0, '#2563EB'], [1, '#DC2626'], [2, '#16A34A']]) box(0.02, 0.03, 0.5 - k * 0.12, c, 21.9, 1.25 + k * 0.22, 4.1 + k * 0.1);
  layout.planSpots = [spot(22.75, 3.9, -Math.PI / 2), spot(22.75, 4.8, -Math.PI / 2)];
  // two sessions editing the same file meet here and argue it out
  layout.clashSpots = [spot(24.7, 7.9, Math.PI / 2), spot(26.3, 7.9, -Math.PI / 2), spot(25.5, 7.1, 0)];
  // the build board and the payroll board, above the back row of desks
  ciBoard = board(24.2, 2.05, TERM.z0 + 0.12, 1.9, 1.1, 512, 296);
  payBoard = board(26.85, 2.05, TERM.z0 + 0.12, 1.9, 1.1, 512, 296);
  // where a session waiting for you stands: by the door, facing the camera
  layout.waitSpots = [24.3, 25.5, 26.7, 27.9, 23.1].map((x) => spot(x, 9.1, 0));
  layout.pools.push([25.5, 3], [25.5, 7]);
}

// ------------------------------------------------------------------ the rec wing: game room, gym, chill zone, careers fair
function buildRec(fair) {
  const R = REC, P = spots.main, RX = -34; // RX: where the game room, gym and fair start; west of it, pods and the lab
  shell(R, [-28, -26.5]);
  room(RX, R.z0, R.x1, -4, { s: [[-31.5, -29.5], [-24.5, -22.5]] });
  room(RX, 4, R.x1, R.z1, { n: [[-32, -30.5], [-27.8, -26.3], [-23.4, -21.9]] });
  zone(RX, R.z0, R.x1, -4, '#7C3AED', { label: 'GAME ROOM', labelW: 4, labelZ: -5.1 });
  zone(RX, -4, -27, 4, '#16A34A', { label: 'GYM', labelW: 2.4, labelZ: 3.2 });
  zone(-27, -4, R.x1, 4, '#F59E0B', { label: 'CHILL ZONE', labelW: 3.4, labelZ: 3.2 });
  // pool table
  box(2.4, 0.12, 1.3, '#0F6B3A', -27, 0.72, -8.5, { block: true });
  box(2.6, 0.14, 1.5, '#5B3A22', -27, 0.62, -8.5);
  for (const [dx, dz] of [[-1.1, -0.55], [1.1, -0.55], [-1.1, 0.55], [1.1, 0.55]]) box(0.12, 0.62, 0.12, '#5B3A22', -27 + dx, 0, -8.5 + dz);
  P.pool.push(spot(-28.75, -8.5, Math.PI / 2), spot(-25.25, -8.5, -Math.PI / 2));
  // foosball
  box(1.3, 0.25, 0.75, '#1F2937', -23, 0.62, -11, { block: true });
  box(1.2, 0.03, 0.65, '#22C55E', -23, 0.86, -11);
  for (let k = 0; k < 4; k++) box(0.03, 0.03, 1.1, '#C0C0C0', -23.45 + k * 0.3, 0.92, -11);
  P.foosball.push(spot(-23, -11.85, 0), spot(-23, -10.15, Math.PI));
  // arcade cabinets along the west wall
  for (const [k, c] of [[0, '#DB2777'], [1, '#2563EB'], [2, '#F59E0B']]) {
    const z = -12 + k * 1.1;
    box(0.7, 1.75, 0.8, c, RX + 0.5, 0, z, { block: true });
    box(0.05, 0.45, 0.55, '#0B1020', RX + 0.87, 1.15, z, { shadow: false });
    P.arcade.push(spot(RX + 1.55, z, -Math.PI / 2));
  }
  // darts on the north wall
  cyl(0.24, 0.05, '#111', -30.5, 1.6, R.z0 + 0.12, { segs: 20 });
  P.darts.push(spot(-30.5, -10.6, Math.PI));
  plant(R.x1 - 0.6, R.z0 + 0.6, 1, 'tree_round');
  // gym: treadmills, a bench, yoga mats
  for (const z of [-2.6, -0.6]) {
    box(1.7, 0.18, 0.75, '#334155', -32.3, 0, z, { block: false });
    box(0.08, 1.1, 0.75, '#334155', -31.45, 0, z);
    P.treadmill.push(spot(-32.4, z, Math.PI / 2, 'stand', { y: 0.18 }));
  }
  box(1.3, 0.42, 0.4, '#111827', -29.3, 0, -2.4, { block: true });
  box(0.05, 0.05, 1.5, '#9CA3AF', -29.3, 0.95, -2.4); cyl(0.2, 0.08, '#111', -29.3, 0.86, -3.1, { segs: 12 }); cyl(0.2, 0.08, '#111', -29.3, 0.86, -1.7, { segs: 12 });
  P.weights.push(spot(-29.3, -1.85, Math.PI));
  for (const [x, c] of [[-32.6, '#EC4899'], [-31, '#06B6D4'], [-29.4, '#84CC16']]) { box(0.65, 0.02, 1.6, c, x, 0, 1.9, { shadow: false }); P.yoga.push(spot(x, 1.9, 0)); }
  // chill zone: beanbags round a console TV
  put('dev_tv', -20.35, 0, -Math.PI / 2, { block: true });
  for (const [x, z, c] of [[-23.4, -1.6, '#EF4444'], [-23.6, 0, '#3B82F6'], [-23.4, 1.6, '#F59E0B'], [-25.4, -0.8, '#10B981'], [-25.4, 0.9, '#8B5CF6']]) {
    const bag = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), M(c));
    bag.scale.set(1, 0.55, 1); bag.position.set(x, 0.22, z); bag.castShadow = true; scene.add(bag);
    P.beanbag.push(spot(x, z, Math.PI / 2, 'sit', { seatY: 0.42, ax: x - 0.6, az: z }));
  }
  box(3.2, 0.01, 4.4, '#FDE68A', -24.2, 0, 0, { shadow: false });
  P.lounge.push(...[-0.5, 0.5].map((d) => spot(-26.4, 2.9 + d, Math.PI / 2, 'sit', { ax: -25.5, az: 2.9 + d })));
  put('dev_sofa', -26.6, 2.9, Math.PI / 2, { tint: '#F59E0B', tintParts: ['cushion'] });
  // careers fair: a booth per kind of candidate, six chairs each
  const bw = (R.x1 - RX) / Math.max(1, fair.length);
  fair.forEach((f, k) => {
    const x0 = RX + k * bw, x1 = x0 + bw, xc = (x0 + x1) / 2;
    zone(x0, 4, x1, R.z1, ['#0EA5E9', '#DB2777', '#F97316'][k % 3], { mix: 0.24, label: f.name.toUpperCase(), labelW: 3.2, sub: f.sub || 'careers fair', labelZ: R.z1 - 1.0 });
    for (let dx = -1.25; dx <= 1.25; dx += 0.5) put('counter', xc + dx, 4.75, 0, { block: true });
    layout.fair[f.id] = [[-1.3, 7.2], [0, 7.2], [1.3, 7.2], [-1.3, 9.2], [0, 9.2], [1.3, 9.2]].map(([dx, z]) => {
      put('dev_chair', xc + dx, z, 0, { tint: ['#0EA5E9', '#DB2777', '#F97316'][k % 3], tintParts: ['seat'] });
      return spot(xc + dx, z, 0, 'sit');
    });
    layout.pools.push([xc, 8.2]);
  });
  floorText('CAREERS FAIR', -27, 5.8, { w: 4.5, color: '#2A2420', alpha: 0.35 });
  for (const z of [-9, 0, 8]) put('dev_wall_light', RX + 0.08, z, Math.PI / 2);
  put('dev_aircon', -27, R.z0 + 0.1, 0);
  layout.pools.push([-27, -8.5], [-30.5, 0], [-23.5, 0]);

  // nap pods: six capsules along the west wall, for the night shift and the odd afternoon nap
  room(R.x0, R.z0, RX, 3, { e: [[0.3, 1.3]] });
  zone(R.x0, R.z0, RX, 3, '#334155', { mix: 0.3, label: 'NAP PODS', labelW: 3, labelZ: 2.1 });
  for (let k = 0; k < 6; k++) {
    const z = -12 + k * 2.2;
    box(1.5, 1.25, 1.9, '#E2E8F0', R.x0 + 0.85, 0, z, { block: true });
    box(0.04, 0.85, 1.4, '#1E293B', R.x0 + 1.61, 0.2, z, { shadow: false });
    box(0.02, 0.06, 1.2, ['#38BDF8', '#A78BFA', '#F472B6', '#34D399', '#FBBF24', '#F87171'][k], R.x0 + 1.63, 1.12, z, { shadow: false });
    P.pod.push(spot(R.x0 + 2.0, z, Math.PI / 2, 'sit', { ax: R.x0 + 2.6, az: z }));
  }
  layout.pools.push([R.x0 + 3, -6], [R.x0 + 3, 0]);

  // the BIM lab: your newest IFC model on the table (a sample until there is one), two workstations
  room(R.x0, 3, RX, R.z1, { e: [[7, 8.5]] });
  zone(R.x0, 3, RX, R.z1, '#0891B2', { mix: 0.28, label: 'BIM LAB', labelW: 3, sub: 'your models', labelZ: R.z1 - 0.9 });
  box(2.6, 0.8, 1.7, '#1E293B', -37, 0, 8.0, { block: true });
  box(2.5, 0.03, 1.6, '#0EA5E9', -37, 0.8, 8.0, { shadow: false });
  const model = new THREE.Group();
  model.position.set(-37, 0.84, 8.0);
  scene.add(model);
  for (const [x, z, f] of [[-37, 6.6, 0], [-37, 9.4, Math.PI], [-38.75, 8.0, Math.PI / 2], [-35.25, 8.0, -Math.PI / 2]]) P.lab.push(spot(x, z, f));
  for (const z of [4.6, 11.4]) P.lab.push(desk(R.x0 + 0.7, z, Math.PI / 2, { chairTint: '#0891B2' }));
  layout.lab = { model, screen: board(-37, 2.05, 3.12, 2.4, 1.3, 512, 280) };
  layout.pools.push([-37, 8]);
  for (const z of [-9, 0, 8]) put('dev_wall_light', R.x0 + 0.08, z, Math.PI / 2);
}

// ------------------------------------------------------------------ the usage TV, clock and Employee of the Month
export let tv, eom, clockHands, dundieBoard, ciBoard, payBoard;
/** A canvas board on a wall facing +z. */
function board(x, y, z, w, h, cw, ch) {
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  box(w + 0.1, h + 0.1, 0.04, '#2a2a2a', x, y - (h + 0.1) / 2, z - 0.02, { shadow: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  m.position.set(x, y, z + 0.005);
  scene.add(m);
  return { canvas, tex };
}
function buildBoards() {
  const tvCanvas = document.createElement('canvas');
  tvCanvas.width = 768; tvCanvas.height = 432;
  const tvTex = new THREE.CanvasTexture(tvCanvas);
  tvTex.colorSpace = THREE.SRGBColorSpace;
  tvTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const TVX = 0.5, TVZ = -5.35;
  for (const dx of [-1.2, 1.2]) box(0.08, 1.1, 0.08, '#2a2a2a', TVX + dx, 0, TVZ);
  box(0.9, 0.04, 0.4, '#2a2a2a', TVX - 1.2, 0, TVZ); box(0.9, 0.04, 0.4, '#2a2a2a', TVX + 1.2, 0, TVZ);
  box(3.3, 1.9, 0.08, '#111', TVX, 1.05, TVZ);
  blockRect(TVX, TVZ, 3.3, 0.4);
  const tvScreen = new THREE.Mesh(new THREE.PlaneGeometry(3.16, 1.78), new THREE.MeshBasicMaterial({ map: tvTex, toneMapped: false }));
  tvScreen.position.set(TVX, 2.0, TVZ + 0.045);
  scene.add(tvScreen);
  tv = { canvas: tvCanvas, tex: tvTex };

  const clock = new THREE.Group();
  clock.position.set(TVX - 2.4, 1.9, TVZ);
  scene.add(clock);
  box(0.06, 1.5, 0.06, '#2a2a2a', TVX - 2.4, 0, TVZ - 0.06);
  blockRect(TVX - 2.4, TVZ, 0.4, 0.3);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 32), M('#fffaf0'));
  face.rotation.x = Math.PI / 2;
  clock.add(face);
  clock.add(new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.04, 6, 32), M('#d97757')));
  for (let k = 0; k < 12; k++) {
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.03, k % 3 ? 0.05 : 0.09, 0.02), M('#333'));
    const a = (k / 12) * Math.PI * 2;
    tick.position.set(Math.sin(a) * 0.35, Math.cos(a) * 0.35, 0.03);
    tick.rotation.z = -a;
    clock.add(tick);
  }
  const hand = (len, w, color) => {
    const pivot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.015), M(color));
    m.position.y = len / 2 - 0.04;
    pivot.add(m);
    pivot.position.z = 0.04;
    clock.add(pivot);
    return pivot;
  };
  clockHands = { h: hand(0.22, 0.04, '#222'), m: hand(0.32, 0.03, '#222'), s: hand(0.34, 0.012, '#d6453d') };

  const eomCanvas = document.createElement('canvas');
  eomCanvas.width = 256; eomCanvas.height = 320;
  const eomTex = new THREE.CanvasTexture(eomCanvas);
  eomTex.colorSpace = THREE.SRGBColorSpace;
  box(0.06, 1.1, 0.06, '#2a2a2a', TVX + 2.5, 0, TVZ - 0.04);
  box(1.0, 1.25, 0.06, '#8b5a2b', TVX + 2.5, 1.05, TVZ);
  blockRect(TVX + 2.5, TVZ, 1, 0.3);
  const eomBoard = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.12), new THREE.MeshBasicMaterial({ map: eomTex, toneMapped: false }));
  eomBoard.position.set(TVX + 2.5, 1.675, TVZ + 0.035);
  scene.add(eomBoard);
  eom = { canvas: eomCanvas, tex: eomTex };

  // the Dundies: yesterday's awards, handed out at midnight
  const dCanvas = document.createElement('canvas');
  dCanvas.width = 320; dCanvas.height = 320;
  const dTex = new THREE.CanvasTexture(dCanvas);
  dTex.colorSpace = THREE.SRGBColorSpace;
  const DX = TVX + 3.9;
  box(0.06, 1.1, 0.06, '#2a2a2a', DX, 0, TVZ - 0.04);
  box(1.25, 1.25, 0.06, '#C9A227', DX, 1.05, TVZ);
  blockRect(DX, TVZ, 1.25, 0.3);
  const dBoard = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), new THREE.MeshBasicMaterial({ map: dTex, toneMapped: false }));
  dBoard.position.set(DX, 1.675, TVZ + 0.035);
  scene.add(dBoard);
  dundieBoard = { canvas: dCanvas, tex: dTex, spots: [-0.9, 0, 0.9].map((d) => spot(DX + d, TVZ + 1.1, Math.PI)) };
}

function buildAssembly() {
  const A = ASSEMBLY;
  for (let x = -8; x <= 0; x += 1) for (const z of [14.6, 15.7]) layout.assembly.push(spot(x, z, Math.PI));
  floorText('ASSEMBLY POINT', -4, 16.6, { w: 5, color: '#16A34A', alpha: 0.75 });
  box(0.08, 1.6, 0.08, '#555', A.x1 - 0.6, 0, 14.2);
  box(0.6, 0.6, 0.04, '#16A34A', A.x1 - 0.6, 1.3, 14.2);
}

// ------------------------------------------------------------------ branch offices: a glass floor over the terminals per other Mac
// Built on demand (plain meshes, not the kit) when a branch first shows up. Its staff sit; they never walk.
const branchFloors = new Map();
export function branchFloor(machine) {
  if (branchFloors.has(machine)) return branchFloors.get(machine);
  const k = branchFloors.size, y = 3.4 + k * 2.4, T = TERM;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(T.x1 - T.x0, 0.1, T.z1 - T.z0), new THREE.MeshStandardMaterial({ color: '#BFE3F5', transparent: true, opacity: 0.45, roughness: 0.1 }));
  glass.position.set((T.x0 + T.x1) / 2, y - 0.05, (T.z0 + T.z1) / 2);
  scene.add(glass);
  for (const [w, d, x, z] of [[T.x1 - T.x0, 0.06, (T.x0 + T.x1) / 2, T.z0], [T.x1 - T.x0, 0.06, (T.x0 + T.x1) / 2, T.z1], [0.06, T.z1 - T.z0, T.x0, (T.z0 + T.z1) / 2], [0.06, T.z1 - T.z0, T.x1, (T.z0 + T.z1) / 2]]) {
    box(w, 0.9, d, '#9CA3AF', x, y, z, { shadow: false });
  }
  const seats = [[23.3, 3], [25.5, 3], [27.7, 3], [24.4, 6.6], [26.6, 6.6]].map(([x, z]) => {
    box(1.3, 0.05, 0.65, '#C8A27A', x, y + 0.72, z);
    box(0.6, 0.38, 0.04, '#111827', x, y + 0.78, z - 0.15);
    box(0.5, 0.08, 0.5, '#D97757', x, y + 0.42, z + 0.75);
    return spot(x, z + 0.75, Math.PI, 'sit', { seatY: y + 0.45 });
  });
  const el = document.createElement('div');
  el.className = 'sign room';
  el.textContent = `BRANCH · ${machine}`;
  const label = new CSS2DObject(el);
  label.position.set(T.x0 + 1.2, y + 1.2, T.z1);
  scene.add(label);
  const floor = { seats, y, label, el };
  branchFloors.set(machine, floor);
  return floor;
}

export function buildCampus(opts) {
  hqOn = !!opts.hq;
  LIMIT.x1 = hqOn ? 70 : 40;
  site();
  buildMain(opts);
  if (hqOn) buildWL(opts.hq);
  buildTerminals();
  buildRec(opts.fair || []);
  buildAssembly();
  buildBoards();
  buildFloor(MAIN);
  if (hqOn) buildFloor(WLB);
  buildFloor(TERM);
  buildFloor(REC);
  buildWalls();
  buildSkyline();
  commitKit();
  buildPools();
  bakeGrid();
  renderer.shadowMap.needsUpdate = true;
}

// ------------------------------------------------------------------ day and night (Malaysia / Singapore, UTC+8)
const SKY = [[0, '#141A2A'], [5.6, '#1C2440'], [6.6, '#F3B98A'], [7.6, '#DCEFF8'], [12, '#E8F4FA'], [17.6, '#E3F0F6'], [18.9, '#F7B58C'], [19.6, '#3B3358'], [20.6, '#18203A'], [24, '#141A2A']];
export const timeCtl = { override: -1 };
export function mytHours() {
  if (timeCtl.override >= 0) return timeCtl.override;
  const d = new Date();
  return ((d.getUTCHours() + 8) % 24) + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
}
const skyColor = (h) => {
  for (let k = 0; k < SKY.length - 1; k++) {
    const [h0, c0] = SKY[k], [h1, c1] = SKY[k + 1];
    if (h >= h0 && h <= h1) return new THREE.Color(c0).lerp(new THREE.Color(c1), (h - h0) / (h1 - h0));
  }
  return new THREE.Color(SKY[0][1]);
};
export const isNight = (h) => h < 6.8 || h >= 21.5;
// KL weather (set from extras.js): clouds dim the sun, storms switch the lights on early, haze fogs the skyline
export const weather = { cloud: 0, storm: false, haze: 0, flash: 0 };
export function setWeather(w) { Object.assign(weather, w); lastDN = -1; }
const DAY_HEMI = [new THREE.Color('#FFF6E8'), new THREE.Color('#B9D99A')], NIGHT_HEMI = [new THREE.Color('#7E8FC2'), new THREE.Color('#20301F')];
const GLOW = new THREE.Color('#FFC46B'), BLACK = new THREE.Color(0);
let lastDN = -1;
export function applyDayNight(h) {
  const sec = timeCtl.override >= 0 ? 0 : new Date().getUTCSeconds();
  clockHands.h.rotation.z = -((h % 12) / 12) * Math.PI * 2;
  clockHands.m.rotation.z = -(h % 1) * Math.PI * 2;
  clockHands.s.rotation.z = -(sec / 60) * Math.PI * 2;
  if (Math.abs(h - lastDN) < 1 / 120) return; // the light only needs updating every 30 s of clock time
  lastDN = h;
  const grey = weather.haze > 0 ? new THREE.Color('#C9B79C') : new THREE.Color('#8E9AA6');
  scene.background = skyColor(h).lerp(grey, Math.min(0.75, weather.cloud * 0.6 + weather.haze * 0.5) * (h > 6.5 && h < 19.5 ? 1 : 0.3));
  scene.fog = weather.haze > 0 ? new THREE.Fog(scene.background, 95, 300 - weather.haze * 150) : null; // the far skyline goes hazy, the campus stays clear
  const day = clamp(Math.sin((Math.PI * (h - 7.1)) / 12.15), 0, 1) * (1 - weather.cloud * 0.55) * (weather.storm ? 0.6 : 1); // 0 at ~07:06 sunrise and ~19:15 sunset
  const a = (Math.PI * (h - 7.1)) / 12.15;
  sun.position.set(13 + Math.cos(a) * 40, Math.max(Math.sin(a), 0.3) * 45, 18);
  sun.intensity = 0.35 + day * 1.95;
  sun.color.set(day > 0.25 ? '#FFFFFF' : day > 0 ? '#FFB07A' : '#AFC2FF');
  const k = Math.min(1, day * 2.5);
  hemi.color.copy(NIGHT_HEMI[0]).lerp(DAY_HEMI[0], k);
  hemi.groundColor.copy(NIGHT_HEMI[1]).lerp(DAY_HEMI[1], k);
  hemi.intensity = 0.9 + k * 0.8;
  const dark = 1 - Math.min(1, day * 3);
  for (const m of cityLights) m.emissiveIntensity = dark * 1.4;
  if (poolMesh) poolMesh.material.opacity = dark * 0.34;
  for (const m of bulbMats) m.emissive.copy(BLACK).lerp(GLOW, dark);
  renderer.shadowMap.needsUpdate = true;
  const hh = Math.floor(h), mm = Math.floor((h % 1) * 60);
  $('phase').textContent = h < 6.8 ? 'night' : h < 12 ? 'morning' : h < 18.5 ? 'afternoon' : h < 21.5 ? 'evening' : 'night';
  $('clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
