#!/usr/bin/env node
// Clawd Mifflin office server. Zero dependencies.
//   node server.mjs             serve http://127.0.0.1:4717 with live /api/state
//   node server.mjs --snapshot  write public/state.json for the static (GitHub Pages) demo
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// launchd starts the server with a bare PATH: add the usual places for gh, eas and friends
process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')])].filter(Boolean).join(':');
const PUBLIC = path.join(ROOT, 'public');
const CLAUDE = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PORT = Number(process.env.PORT) || 4717;
const cast = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'cast.json'), 'utf8'));
const castById = Object.fromEntries(cast.characters.map((c) => [c.id, c]));

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ------------------------------------------------------------------ roster
function pluginDir(name) {
  const inst = readJson(path.join(CLAUDE, 'plugins/installed_plugins.json'))?.plugins || {};
  const key = Object.keys(inst).find((k) => k.split('@')[0] === name);
  if (key) {
    const list = inst[key];
    return (list.find((e) => e.scope === 'user') || list.at(-1)).installPath;
  }
  const synced = path.join(CLAUDE, 'plugins/synced');
  for (const org of fs.existsSync(synced) ? fs.readdirSync(synced) : []) {
    for (const d of [name, `${name}~g2`]) {
      const p = path.join(synced, org, d);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function pluginInfo(name) {
  const dir = pluginDir(name);
  if (!dir) return { mcp: [], skills: 0 };
  const meta = readJson(path.join(dir, '.claude-plugin/plugin.json')) || {};
  const mcpFile = readJson(path.join(dir, '.mcp.json')) || readJson(path.join(dir, 'mcp.json')) || {};
  const servers = mcpFile.mcpServers || mcpFile;
  const skillsDir = path.join(dir, 'skills');
  return {
    author: typeof meta.author === 'string' ? meta.author : meta.author?.name,
    desc: meta.description,
    version: meta.version,
    url: meta.homepage || (typeof meta.repository === 'string' ? meta.repository : meta.repository?.url),
    mcp: Object.keys(typeof servers === 'object' ? servers : {}),
    skills: fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((f) => !f.startsWith('.')).length : 0,
  };
}

function memory() {
  const out = [];
  const projects = path.join(CLAUDE, 'projects');
  for (const p of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const dir = path.join(projects, p, 'memory');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    const label = p.replace(/^-Users-[^-]+-?/, '') || 'home';
    out.push({ project: label, files: files.map((f) => f.replace(/\.md$/, '')) });
  }
  return out;
}

// Where to get it: a web page for every plugin, MCP server and repo, so it can be found again or shared.
const webUrl = (u) => (u && /^https?:\/\//.test(u) ? u.replace(/^git\+/, '').replace(/\.git$/, '') : undefined);
export function sourceUrl(src, repo) {
  if (typeof src === 'string') return repo && `${repo}/tree/main/${src.replace(/^\.\/?/, '')}`.replace(/\/tree\/main\/$/, '');
  if (src?.source === 'github') return `https://github.com/${src.repo}`;
  if (src?.source === 'git-subdir') return `${webUrl(src.url)}/tree/${src.ref || 'main'}/${src.path}`;
  return webUrl(src?.url);
}
function mcpUrl(v = {}) {
  if (v.url) { try { return new URL(v.url).origin; } catch { return undefined; } }
  const pkg = (v.args || []).find((a) => !a.startsWith('-') && /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~-]+)?$/.test(a));
  return v.command === 'npx' && pkg ? `https://www.npmjs.com/package/${pkg.replace(/(.)@[^/]*$/, '$1')}` : undefined;
}
let marketCache = { at: 0, urls: new Map() };
function marketUrls() {
  if (Date.now() - marketCache.at > 3600e3) marketCache = { at: Date.now(), urls: new Map(marketplace().map((p) => [p.name, p.url])) };
  return marketCache.urls;
}

export function roster() {
  const settings = readJson(path.join(CLAUDE, 'settings.json')) || {};
  const needsAuth = Object.keys(readJson(path.join(CLAUDE, 'mcp-needs-auth-cache.json')) || {})
    .map((k) => slug(k.replace(/^plugin:[^:]+:/, '').replace(/^claude\.ai /, '')));
  const chars = new Map();
  const add = (c) => {
    const base = castById[c.id] || {};
    const prev = chars.get(c.id) || {};
    chars.set(c.id, { ...base, ...prev, ...c, known: !!castById[c.id] });
  };

  for (const c of cast.characters) if (c.core || c.connector) add({ id: c.id, enabled: true });

  const enabled = { ...settings.enabledPlugins };
  for (const org of fs.existsSync(path.join(CLAUDE, 'plugins/synced')) ? fs.readdirSync(path.join(CLAUDE, 'plugins/synced')) : []) {
    const man = readJson(path.join(CLAUDE, 'plugins/synced', org, 'manifest.json'));
    for (const p of man?.plugins || []) {
      const key = Object.keys(enabled).find((k) => k.split('@')[0].replace(/~g2$/, '') === p.name);
      if (!key) enabled[`${p.name}@synced`] = true;
    }
  }
  for (const [key, on] of Object.entries(enabled)) {
    const name = key.split('@')[0].replace(/~g2$/, '');
    const info = pluginInfo(name);
    const base = castById[name];
    add({
      id: name, name: base?.name || name, enabled: !!on, source: key.split('@')[1],
      kind: base?.kind || (info.mcp.length ? 'mcp' : 'plugin'),
      author: info.author, desc: info.desc, mcp: info.mcp, skills: info.skills, version: info.version,
      url: webUrl(info.url) || marketUrls().get(name) || (key.endsWith('@synced') || key.includes('knowledge-work') ? `https://github.com/anthropics/knowledge-work-plugins/tree/main/${name}` : undefined),
    });
  }

  for (const s of fs.existsSync(path.join(CLAUDE, 'skills')) ? fs.readdirSync(path.join(CLAUDE, 'skills')) : []) {
    if (s === 'synced' || s.startsWith('.')) continue;
    add({ id: s, name: castById[s]?.name || s, kind: 'skill', enabled: true });
  }

  const cfg = readJson(path.join(os.homedir(), '.claude.json')) || {};
  const userMcp = new Map(Object.entries(cfg.mcpServers || {}));
  for (const p of Object.values(cfg.projects || {})) for (const [k, v] of Object.entries(p.mcpServers || {})) userMcp.set(k, v);
  for (const [m, v] of userMcp) add({ id: slug(m), name: m, kind: 'mcp', enabled: true, url: mcpUrl(v) });

  for (const c of chars.values()) {
    if (needsAuth.includes(c.id)) c.needsAuth = true;
    c.vendor ||= 'other';
    c.url ||= c.kind === 'boss' ? 'https://claude.com/product/claude-code' : ['core', 'archive', 'reception', 'hr'].includes(c.kind) ? 'https://code.claude.com/docs/en/overview' : undefined;
  }
  const hooks = Object.entries(settings.hooks || {}).map(([event, list]) => ({ event, count: list.length }));
  Object.assign(chars.get('hooks'), { hooks });
  Object.assign(chars.get('memory'), { memory: memory() });
  return [...chars.values()];
}

// ------------------------------------------------------------------ activity
// Which character does a tool call belong to?
export function charFor(name, input = {}, ids = new Set()) {
  const p = String(input.file_path || input.path || input.notebook_path || '');
  if (p.includes('/memory/')) return 'memory';
  if (name.startsWith('mcp__')) {
    const server = name.slice(5).split('__')[0];
    if (server.startsWith('plugin_')) {
      const rest = server.slice(7);
      const hit = [...ids].filter((id) => rest === id || rest.startsWith(`${id}_`)).sort((a, b) => b.length - a.length)[0];
      return hit || slug(rest.split('_')[0]);
    }
    if (server.startsWith('claude_ai_')) return slug(server.slice(10));
    return slug(server);
  }
  if (name === 'Skill') {
    const s = String(input.skill || input.command || '');
    if (s.includes(':')) return s.split(':')[0];
    return ids.has(s) ? s : 'claude';
  }
  if (name === 'Agent' || name === 'Task') {
    const t = String(input.subagent_type || '');
    return t.includes(':') ? t.split(':')[0] : 'agent';
  }
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell' || name === 'Monitor') return 'bash';
  if (['Read', 'Grep', 'Glob', 'LS', 'LSP'].includes(name)) return 'reader';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'editor';
  if (name === 'WebSearch' || name === 'WebFetch') return 'web';
  if (/^(Task|Todo)/.test(name)) return 'tasks';
  if (name.startsWith('Artifact')) return 'artifact';
  return 'claude';
}

export function toolLabel(name, input = {}) {
  if (name.startsWith('mcp__')) return name.split('__').at(-1);
  if (name === 'Skill') return `skill ${input.skill || ''}`.trim();
  if (name === 'Agent' || name === 'Task') return `agent ${input.subagent_type || ''}`.trim();
  if (name === 'Bash' && input.description) return `bash: ${String(input.description).slice(0, 40)}`;
  const f = input.file_path || input.path;
  return f ? `${name} ${path.basename(String(f))}` : name;
}

function recentTranscripts(maxAgeMs) {
  const out = [];
  const now = Date.now();
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        const st = fs.statSync(f);
        if (now - st.mtimeMs < maxAgeMs) out.push({ file: f, mtime: st.mtimeMs });
      }
    }
  };
  walk(path.join(CLAUDE, 'projects'), 0);
  return out;
}

function tailLines(file, bytes = 384 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    return lines;
  } finally { fs.closeSync(fd); }
}

const LINGER = 6000;          // keep a character at the desk a bit after a quick tool call
const STALE = 5 * 60 * 1000;  // a call without result in a file idle this long was interrupted

// Your own project's building (the HQ) comes from private/hq.json, which git ignores: its name, features and
// code paths only ever reach this Mac's page and, behind the live password, the relay. Never the public demo.
const WL = readJson(path.join(ROOT, 'private/hq.json'));
// Which HQ feature does a file path belong to?
export function wlFeature(file, features = WL?.features || [], root = WL?.root) {
  const f = String(file || '');
  const at = root ? f.indexOf(`/${root}/`) : -1;
  if (at < 0) return null;
  const rel = f.slice(at + root.length + 2);
  return features.find((ft) => ft.paths.some((p) => rel.startsWith(p)))?.id || null;
}

// What went wrong, and on what: the start of a failed call's result, and its command or file.
export function resultText(content) {
  const t = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text || '').join('\n') : '';
  return t.replace(/<\/?tool_use_error>/g, '').trim().slice(0, 400);
}
function inputText(name, input = {}) {
  return String(input.command || input.file_path || input.path || input.url || input.pattern || input.skill || '').slice(0, 160);
}

// Pure: turn parsed transcript records into per-character status. Exported for the test.
export function activity(files, ids, now = Date.now()) {
  const uses = [], done = new Map(), hooks = [];
  const sessions = new Map(); // sid -> { last, cwd }
  const midnight = now - ((now + 8 * 3600e3) % 86400e3);
  const pay = new Map(), billed = new Set(); // tokens per session today; each API message counted once
  for (const { records, mtime, peak = 0 } of files) {
    for (const r of records) {
      // permission-mode records carry no timestamp: the newest one in the file wins
      if (r.type === 'permission-mode' && r.sessionId) { const s = sessions.get(r.sessionId) || { last: 0, turn: 0 }; s.mode = r.permissionMode; sessions.set(r.sessionId, s); continue; }
      const ts = Date.parse(r.timestamp);
      if (!ts) continue;
      const sid = r.sessionId || 'unknown';
      const usage = r.type === 'assistant' && r.message?.usage;
      if (usage && ts >= midnight && !billed.has(r.message.id || r.uuid)) {
        billed.add(r.message.id || r.uuid);
        const p = pay.get(sid) || { id: sid, project: r.cwd ? path.basename(r.cwd) : 'session', input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        p.input += usage.input_tokens || 0; p.cacheRead += usage.cache_read_input_tokens || 0;
        p.cacheWrite += usage.cache_creation_input_tokens || 0; p.output += usage.output_tokens || 0;
        pay.set(sid, p);
      }
      if (!r.isSidechain && (r.type === 'assistant' || r.type === 'user' || r.subtype === 'compact_boundary')) {
        const s = sessions.get(sid) || { last: 0, cwd: r.cwd, turn: 0 };
        s.cwd ||= r.cwd;
        s.peak = Math.max(s.peak || 0, peak);
        if (r.subtype === 'compact_boundary') {
          s.compactedAt = Math.max(s.compactedAt || 0, ts);
          s.peak = Math.max(s.peak || 0, r.compactMetadata?.preTokens || 0);
        } else if (ts >= s.turn) {
          // the newest message decides whether Claude is waiting: an answer that ended the turn means your move
          s.turn = ts;
          s.ended = r.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(r.message?.stop_reason);
        }
        if (r.type === 'user' && r.permissionMode) s.mode = r.permissionMode;
        if (r.type === 'assistant') {
          if (r.message?.model && !r.message.model.startsWith('<')) s.model = r.message.model;
          if (r.effort) s.effort = r.effort;
          s.last = Math.max(s.last, ts);
          const u = r.message?.usage;
          if (u && ts >= (s.ctxAt || 0)) { s.ctxAt = ts; s.tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); }
        }
        sessions.set(sid, s);
      }
      const content = Array.isArray(r.message?.content) ? r.message.content : [];
      for (const c of content) {
        if (c.type === 'tool_use') uses.push({ id: c.id, name: c.name, input: c.input || {}, ts, mtime, sid, side: !!r.isSidechain });
        if (c.type === 'tool_result') done.set(c.tool_use_id, { ts, error: c.is_error === true, text: c.is_error === true ? resultText(c.content) : '' });
      }
      const a = r.attachment;
      if (a && /^hook_/.test(a.type) && a.hookEvent) hooks.push({ ts, label: a.hookName || a.hookEvent });
    }
  }
  const status = {};
  const set = (id, s) => { if (!status[id] || s.since > status[id].since) status[id] = s; };
  const subagents = [], failures = [];
  for (const u of uses) {
    const end = done.get(u.id);
    const pending = !end && now - u.mtime < STALE && now - u.ts < 30 * 60 * 1000;
    const working = end ? now - end.ts < LINGER : pending;
    const who = charFor(u.name, u.input, ids);
    const tool = toolLabel(u.name, u.input);
    if (working) {
      set(who, { working: true, tool, since: u.ts, session: u.sid });
      const wl = wlFeature(u.input.file_path || u.input.path || u.input.notebook_path);
      if (wl) set(wl, { working: true, tool, since: u.ts, session: u.sid });
    }
    if ((u.name === 'Agent' || u.name === 'Task') && pending) {
      subagents.push({ id: u.id, type: String(u.input.subagent_type || 'general-purpose'), desc: String(u.input.description || '').slice(0, 60), session: u.sid, since: u.ts });
    }
    if (end?.error && now - end.ts < 60000) failures.push({ id: u.id, char: who, tool, t: end.ts, session: u.sid, detail: end.text, input: inputText(u.name, u.input) });
  }
  for (const h of hooks) if (now - h.ts < LINGER) set('hooks', { working: true, tool: h.label, since: h.ts });
  // One Claude per session that answered in the last 10 minutes (30 if it is waiting for you), newest first.
  // ponytail: context window guessed from size (200k, or 1M once a session went past 200k); the model id doesn't say.
  const list = [...sessions.entries()].filter(([, s]) => s.last && now - s.last < (s.ended ? 30 : 10) * 60 * 1000)
    .map(([id, s]) => ({
      id, project: s.cwd ? path.basename(s.cwd) : 'session', last: s.last,
      busy: !s.ended && (now - s.last < 20000 || Object.values(status).some((st) => st.session === id)),
      waiting: s.ended ? 'reply' : null,
      model: s.model, effort: s.effort, mode: s.mode,
      ctx: s.tokens ? { tokens: s.tokens, max: Math.max(s.tokens, s.peak || 0) > 200000 ? 1000000 : 200000, compactedAt: s.compactedAt || 0 } : null,
    }))
    .sort((a, b) => b.last - a.last);
  const activeSessions = list.filter((s) => now - s.last < 2 * 60 * 1000).length;
  if (list.some((s) => s.busy) && !status.claude) status.claude = { working: true, tool: 'thinking', since: now, session: list.find((s) => s.busy).id };
  // Calls per character since midnight MYT/SGT (UTC+8), for Employee of the Month.
  const counts = {};
  for (const u of uses) if (u.ts >= midnight) { const who = charFor(u.name, u.input, ids); counts[who] = (counts[who] || 0) + 1; }
  // today's calls, oldest first, for the replay: [time, character, tool, failed]
  const replay = uses.filter((u) => u.ts >= midnight && !u.side).sort((a, b) => a.ts - b.ts).slice(-2000)
    .map((u) => [u.ts, charFor(u.name, u.input, ids), toolLabel(u.name, u.input).slice(0, 40), done.get(u.id)?.error ? 1 : 0]);
  const events = uses.filter((u) => now - u.ts < 86400e3).sort((a, b) => b.ts - a.ts).slice(0, 40)
    .map((u) => {
      const end = done.get(u.id);
      const e = { t: u.ts, char: charFor(u.name, u.input, ids), tool: toolLabel(u.name, u.input), error: end?.error || false };
      if (end?.error) Object.assign(e, { id: u.id, detail: end.text, input: inputText(u.name, u.input) });
      return e;
    });
  const payroll = [...pay.values()].sort((a, b) => b.input + b.cacheRead + b.cacheWrite + b.output - (a.input + a.cacheRead + a.cacheWrite + a.output));
  return { status, events, activeSessions, counts, sessions: list, subagents, failures, replay, payroll, clashes: clashes(uses, now) };
}

// Two sessions editing the same file within 10 minutes of each other, the latest edit in the last 2 minutes:
// they will overwrite each other's work. Pure, exported for the test.
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export function clashes(uses, now = Date.now()) {
  const byFile = new Map();
  for (const u of uses) {
    const f = EDITS.has(u.name) && (u.input.file_path || u.input.notebook_path);
    if (!f || now - u.ts > 10 * 60e3) continue;
    const m = byFile.get(f) || new Map();
    m.set(u.sid, Math.max(m.get(u.sid) || 0, u.ts));
    byFile.set(f, m);
  }
  const out = [];
  for (const [file, m] of byFile) {
    const last = Math.max(...m.values());
    if (m.size < 2 || now - last > 2 * 60e3) continue;
    out.push({ id: `${file}|${[...m.keys()].sort().join(',')}`, file: String(file).split('/').slice(-2).join('/'), sessions: [...m.keys()], t: last });
  }
  return out;
}

// The biggest context a transcript ever reached (from its compactions), read once and then only what was
// appended: it tells a 1M-token session from a 200k one even after the compaction scrolled out of the tail.
const peaks = new Map(); // file -> { size, peak }
function peakOf(file) {
  const p = peaks.get(file) || { size: 0, peak: 0 };
  const size = fs.statSync(file).size;
  if (size > p.size) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      let carry = '';
      for (let pos = p.size; pos < size;) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        if (!n) break;
        pos += n;
        const text = carry + buf.toString('latin1', 0, n);
        for (const m of text.matchAll(/"preTokens":(\d+)/g)) p.peak = Math.max(p.peak, Number(m[1]));
        carry = text.slice(-24);
      }
    } finally { fs.closeSync(fd); }
    p.size = size;
    peaks.set(file, p);
  }
  return p.peak;
}

function liveActivity(ids) {
  const now = Date.now();
  const files = recentTranscripts(Math.max(30 * 60e3, (now + 8 * 3600e3) % 86400e3)).map(({ file, mtime }) => ({
    mtime, peak: peakOf(file),
    // 2 MB: one screenshot read in a session is a ~1 MB line, and a smaller tail could hold nothing else
    records: tailLines(file, 2 << 20).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean),
  }));
  return activity(files, ids);
}

// ------------------------------------------------------------------ the Dundies: awards for the day (MYT)
// Pure: [time, character, tool, failed] calls of one day -> awards. Exported for the test.
export function dundies(replay, skip = new Set(['claude'])) {
  const per = new Map();
  for (const [t, who, , err] of replay) {
    if (skip.has(who)) continue;
    const p = per.get(who) || { calls: 0, fails: 0, night: 0, gap: 0, last: 0 };
    const h = ((t + 8 * 3600e3) % 86400e3) / 3600e3;
    p.calls++; p.fails += err ? 1 : 0; p.night += h < 6 || h >= 22 ? 1 : 0;
    if (p.last) p.gap = Math.max(p.gap, t - p.last);
    p.last = t;
    per.set(who, p);
  }
  const best = (key, min = 1) => { let w = null; for (const [id, p] of per) if (p[key] >= min && (!w || p[key] > w[1])) w = [id, p[key]]; return w; };
  const out = [];
  const add = (award, w, unit) => w && out.push({ award, char: w[0], value: unit(w[1]) });
  add('Most Tool Calls', best('calls'), (n) => `${n} calls`);
  add('Butterfingers', best('fails'), (n) => `${n} failed`);
  add('Night Owl', best('night'), (n) => `${n} after hours`);
  add('Longest Nap', best('gap', 30 * 60e3), (ms) => `${Math.floor(ms / 3600e3)}h ${Math.floor((ms % 3600e3) / 60e3)}m`);
  return out;
}
const DUNDIES_FILE = path.join(os.homedir(), '.config/clawd-mifflin/dundies.json');
let dundieStore = readJson(DUNDIES_FILE) || { today: null, last: null };
const mytDay = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
function dundiesFor(replay) {
  const day = mytDay(Date.now());
  // the server runs all day, so the last awards it saw for a day are that day's final awards
  if (dundieStore.today && dundieStore.today.day !== day) dundieStore = { today: null, last: dundieStore.today, history: [...(dundieStore.history || []), dundieStore.today].slice(-60) };
  const today = { day, awards: dundies(replay) };
  if (JSON.stringify(today) !== JSON.stringify(dundieStore.today)) {
    dundieStore.today = today;
    try { fs.mkdirSync(path.dirname(DUNDIES_FILE), { recursive: true }); fs.writeFileSync(DUNDIES_FILE, JSON.stringify(dundieStore)); } catch { /* board only */ }
  }
  return dundieStore;
}

// ------------------------------------------------------------------ deliveries: today's HQ commits
const WL_DIR = WL?.root && path.resolve(ROOT, '..', WL.root);
let commitCache = { at: 0, data: [] };
function commits() {
  if (!WL_DIR || Date.now() - commitCache.at < 30000) return Promise.resolve(commitCache.data);
  commitCache.at = Date.now();
  return new Promise((resolve) => {
    execFile('git', ['-C', WL_DIR, 'log', '--since=24 hours ago', '-n', '20', '--name-only', '--format=%x1e%h%x09%ct%x09%s'], { timeout: 5000 }, (err, out) => {
      if (!err) commitCache.data = String(out).split('\x1e').filter((b) => b.trim()).map((b) => {
        const [head, ...files] = b.split('\n').filter(Boolean);
        const [hash, ct, subject] = head.split('\t');
        const features = [...new Set(files.map((f) => wlFeature(`/${WL.root}/${f}`)).filter(Boolean))];
        return { hash, t: Number(ct) * 1000, subject: String(subject || '').slice(0, 80), features };
      });
      resolve(commitCache.data);
    });
  });
}

// ------------------------------------------------------------------ builds: GitHub Actions for both repos, EAS app builds
const run = (cmd, args, cwd, timeout = 20000) => new Promise((resolve) => execFile(cmd, args, { cwd, timeout, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? null : String(out))));
const parse = (t) => { try { return t && JSON.parse(t); } catch { return null; } };
let buildCache = { at: 0, data: [] };
async function builds() {
  if (!control.live || Date.now() - buildCache.at < 60000) return buildCache.data;
  buildCache.at = Date.now();
  const out = [];
  for (const [repo, dir] of [['hq', WL_DIR], ['office', ROOT]]) {
    if (!dir) continue;
    const runs = parse(await run('gh', ['run', 'list', '--limit', '20', '--json', 'databaseId,workflowName,status,conclusion,createdAt,updatedAt,url,headBranch,displayTitle'], dir)) || [];
    // the latest run of each workflow, leaving out dependabot's branches
    const latest = new Map();
    for (const r of runs) if (!latest.has(r.workflowName) && !/^dependabot\//.test(r.headBranch)) latest.set(r.workflowName, r);
    for (const r of latest.values()) out.push({ repo, id: String(r.databaseId), name: r.workflowName, status: r.status, conclusion: r.conclusion || null, at: Date.parse(r.updatedAt || r.createdAt), url: r.url, title: String(r.displayTitle || '').slice(0, 80) });
  }
  // Expo app builds, when eas-cli is installed and signed in (otherwise this quietly finds nothing)
  const eas = parse(WL_DIR && await run('eas', ['build:list', '--json', '--non-interactive', '--limit', '3'], WL_DIR)) || [];
  for (const b of eas) {
    const done = ['FINISHED', 'ERRORED', 'CANCELED'].includes(b.status);
    out.push({ repo: 'hq', id: b.id, name: `EAS ${String(b.platform || '').toLowerCase()} build`, status: done ? 'completed' : 'in_progress', conclusion: b.status === 'FINISHED' ? 'success' : b.status === 'ERRORED' ? 'failure' : done ? 'cancelled' : null, at: Date.parse(b.updatedAt || b.createdAt), url: b.project?.ownerAccount?.name ? `https://expo.dev/accounts/${b.project.ownerAccount.name}/projects/${b.project.slug}/builds/${b.id}` : undefined });
  }
  buildCache.data = out;
  return out;
}

// ------------------------------------------------------------------ heat map: lines changed per HQ feature this week
let heatCache = { at: 0, data: {} };
export function heatFrom(numstat, features = WL?.features || [], root = WL?.root) {
  const heat = {};
  for (const line of String(numstat).split('\n')) {
    const [a, d, file] = line.split('\t');
    if (!file) continue;
    const id = wlFeature(`/${root}/${file}`, features, root);
    if (id) heat[id] = (heat[id] || 0) + (Number(a) || 0) + (Number(d) || 0);
  }
  return heat;
}
async function heat() {
  if (!WL_DIR || Date.now() - heatCache.at < 10 * 60e3) return heatCache.data;
  heatCache.at = Date.now();
  const out = await run('git', ['-C', WL_DIR, 'log', '--since=7 days ago', '--numstat', '--format='], WL_DIR);
  if (out != null) heatCache.data = heatFrom(out);
  return heatCache.data;
}

// ------------------------------------------------------------------ careers: each character's last 30 days
// Calls per day (MYT) per character, their best day and how many Dundies they won. Read once an hour.
let careerCache = { at: 0, data: null };
async function careers(ids) {
  if (careerCache.data && Date.now() - careerCache.at < 3600e3) return careerCache.data;
  careerCache.at = Date.now();
  const now = Date.now(), today = now - ((now + 8 * 3600e3) % 86400e3), from = today - 29 * 86400e3;
  const chars = {};
  for (const { file } of recentTranscripts(now - from + 3600e3)) for (const l of tailLines(file, 1 << 20)) {
    if (!l.includes('"tool_use"')) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(r.timestamp);
    if (!ts || ts < from) continue;
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (c.type !== 'tool_use') continue;
      const who = charFor(c.name, c.input || {}, ids);
      (chars[who] ||= new Array(30).fill(0))[Math.min(29, Math.floor((ts - from) / 86400e3))]++;
    }
  }
  const wins = {};
  for (const d of [...(dundieStore.history || []), dundieStore.last].filter(Boolean)) for (const w of d.awards || []) wins[w.char] = (wins[w.char] || 0) + 1;
  careerCache.data = { from, chars, wins };
  return careerCache.data;
}

// ------------------------------------------------------------------ the daily digest (Telegram), at digestHour MYT
// Set telegram: { token, chat } in ~/.config/clawd-mifflin/config.json (a bot from @BotFather, your chat id).
export function digestText(s, hqName = WL?.name) {
  const kilo = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const counts = Object.entries(s.counts || {}).sort((a, b) => b[1] - a[1]);
  const calls = counts.reduce((t, [, n]) => t + n, 0), fails = (s.replay || []).filter((r) => r[3]).length;
  const tokens = (s.payroll || []).reduce((t, p) => t + p.input + p.cacheWrite + p.cacheRead + p.output, 0);
  const name = (id) => s.characters?.find((c) => c.id === id)?.name || id;
  const lines = [
    `Clawd Mifflin, ${new Date((s.now || Date.now()) + 8 * 3600e3).toISOString().slice(0, 10)}`,
    `${calls} tool calls, ${fails} failed, ${(s.payroll || []).length} sessions, ${kilo(tokens)} tokens${s.cost ? ` (about $${s.cost.today.toFixed(2)} at API prices; $${s.cost.week.toFixed(2)} this week)` : ''}`,
    counts.length ? `Busiest: ${counts.slice(0, 4).map(([id, n]) => `${name(id)} ${n}`).join(', ')}` : 'A quiet day.',
  ];
  if (s.usage?.session || s.usage?.weekly) lines.push(`Usage: session ${Math.round(s.usage.session?.pct ?? 0)}%, weekly ${Math.round(s.usage.weekly?.pct ?? 0)}%`);
  const today = s.dundies?.today?.awards || [];
  if (today.length) lines.push(`Dundies so far: ${today.map((w) => `${w.award}: ${name(w.char)}`).join('; ')}`);
  if (hqName && s.deliveries?.length) lines.push(`${hqName}: ${s.deliveries.length} commits in 24 h (${s.deliveries.slice(0, 3).map((c) => c.subject).join('; ')})`);
  const red = (s.builds || []).filter((b) => b.conclusion === 'failure');
  if (red.length) lines.push(`Red builds: ${red.map((b) => b.name).join(', ')}`);
  return lines.join('\n');
}
const DIGEST_FILE = path.join(os.homedir(), '.config/clawd-mifflin/digest.json');
async function sendDigest() {
  const tg = PUSH?.telegram;
  if (!tg?.token || !tg?.chat) throw new Error('set telegram: { token, chat } in ~/.config/clawd-mifflin/config.json');
  const text = digestText(await cachedState(false));
  const r = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: tg.chat, text }), signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Telegram said HTTP ${r.status}`);
  return text;
}
function digestTick() {
  const myt = new Date(Date.now() + 8 * 3600e3), day = myt.toISOString().slice(0, 10);
  if (!PUSH?.telegram || !control.live || myt.getUTCHours() !== (PUSH.digestHour ?? 21)) return;
  if ((readJson(DIGEST_FILE) || {}).day === day) return;
  fs.writeFileSync(DIGEST_FILE, JSON.stringify({ day }));
  sendDigest().catch((e) => console.log(`digest: ${e.message}`));
}

// ------------------------------------------------------------------ the BIM lab's model: the newest .ifc on this Mac
// ifcPath in the config wins; otherwise Spotlight finds the newest .ifc in your home folder. Served to this Mac's
// page only: work models never go to the relay.
let ifcCache = { at: 0, file: null };
async function ifcFile() {
  if (PUSH?.ifcPath) return fs.existsSync(PUSH.ifcPath) ? PUSH.ifcPath : null;
  if (Date.now() - ifcCache.at < 10 * 60e3) return ifcCache.file;
  ifcCache.at = Date.now();
  const out = process.platform === 'darwin' ? await run('mdfind', ['-onlyin', os.homedir(), 'kMDItemFSName == "*.ifc"c'], ROOT, 8000) : null;
  const files = String(out || '').split('\n').filter((f) => f.toLowerCase().endsWith('.ifc') && fs.existsSync(f));
  ifcCache.file = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  return ifcCache.file;
}

// ------------------------------------------------------------------ branches: other Macs, through the relay
// A second Mac runs this same server with machine: "<name>" in its config and pushes to the same relay; the relay
// hands its summary to everyone else as a branch office. This Mac reads the branches back with the view password.
let branchCache = { at: 0, data: [] };
async function branches() {
  if (!PUSH?.pushUrl || !PUSH?.viewPassword || !control.live) return branchCache.data;
  if (Date.now() - branchCache.at < 30000) return branchCache.data;
  branchCache.at = Date.now();
  try {
    const r = await fetch(PUSH.machine ? `${PUSH.pushUrl}?machine=${encodeURIComponent(PUSH.machine)}` : PUSH.pushUrl, { headers: { authorization: `Bearer ${PUSH.viewPassword}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) branchCache.data = ((await r.json()).branches || []).filter((b) => b.machine !== PUSH.machine);
  } catch { /* keep the last list */ }
  return branchCache.data;
}

// ------------------------------------------------------------------ cost: what the tokens would cost at API prices
// US dollars per million tokens: [input, 5-minute cache write, 1-hour cache write, cache read, output], from
// platform.claude.com/docs/en/about-claude/pricing (October 2026). On a Claude plan you pay the plan, not this:
// it is the API-price equivalent. Override or add models with "prices" in the config.
const PRICES = {
  'fable-5-1': [10, 12.5, 20, 0.25, 50], 'mythos-5-1': [10, 12.5, 20, 0.25, 50], 'fable-5': [10, 12.5, 20, 1, 50], 'mythos-5': [10, 12.5, 20, 1, 50],
  'opus-5-5': [4, 5, 8, 0.2, 20], 'opus-5': [5, 6.25, 10, 0.5, 25], 'opus-4-8': [5, 6.25, 10, 0.5, 25], 'opus-4-7': [5, 6.25, 10, 0.5, 25],
  'opus-4-6': [5, 6.25, 10, 0.5, 25], 'opus-4-5': [5, 6.25, 10, 0.5, 25], 'opus-4-1': [15, 18.75, 30, 1.5, 75], 'opus-4': [15, 18.75, 30, 1.5, 75],
  'sonnet-5-5': [2, 2.5, 4, 0.1, 10], 'sonnet-5': [2, 2.5, 4, 0.2, 10], 'sonnet-4-6': [3, 3.75, 6, 0.3, 15], 'sonnet-4-5': [3, 3.75, 6, 0.3, 15], 'sonnet-4': [3, 3.75, 6, 0.3, 15],
  'haiku-5-5': [0.1, 0.125, 0.2, 0.01, 0.5], 'haiku-5-5-long': [0.5, 0.625, 1, 0.05, 2.5], 'haiku-4-5': [1, 1.25, 2, 0.1, 5], 'haiku-3-5': [0.8, 1, 1.6, 0.08, 4],
  ...(readJson(path.join(os.homedir(), '.config/clawd-mifflin/config.json'))?.prices || {}), // read here: the config is loaded further down
};
const FAST = { 'opus-5-5': [8, 40], 'opus-5': [10, 50], 'opus-4-8': [10, 50] }; // fast mode input/output; cache multipliers apply on top
/** Pure: dollars for one API message. Exported for the test. */
export function costOf(model = '', u = {}) {
  const id = /claude-([a-z]+-\d+(?:-\d+)?)/.exec(model)?.[1];
  const base = id && (PRICES[id] || PRICES[id.replace(/-\d+$/, '')]);
  if (!base) return 0; // unknown or synthetic model: no guess
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0, write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? ((u.cache_creation_input_tokens || 0) - write1h);
  const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  let [inp, w5, w1, read, out] = id === 'haiku-5-5' && prompt > 100000 ? PRICES['haiku-5-5-long'] : base;
  const fast = u.speed === 'fast' && FAST[id];
  if (fast) [inp, w5, w1, read, out] = [fast[0], fast[0] * (w5 / inp), fast[0] * (w1 / inp), fast[0] * (read / inp), fast[1]];
  const geo = /^us/i.test(u.inference_geo || '') ? 1.1 : 1;
  const searches = (u.server_tool_use?.web_search_requests || 0) * 0.01;
  return (((u.input_tokens || 0) * inp + write5m * w5 + write1h * w1 + (u.cache_read_input_tokens || 0) * read + (u.output_tokens || 0) * out) / 1e6) * geo + searches;
}

// A running ledger per transcript, read once and then only what was appended: tokens and cost per MYT day per
// session, each API message counted once. Feeds the payroll board, the week's total and the digest.
const ledgers = new Map(); // file -> { size, carry, seen: Set, days: { day: { sid: row } } }
const mytDayOf = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
export function addToLedger(L, line) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let r; try { r = JSON.parse(line); } catch { return; }
  const u = r.message?.usage, ts = Date.parse(r.timestamp), id = r.message?.id || r.uuid;
  if (r.type !== 'assistant' || !u || !ts || L.seen.has(id)) return;
  L.seen.add(id);
  const day = (L.days[mytDayOf(ts)] ||= {}), sid = r.sessionId || 'unknown';
  const row = (day[sid] ||= { id: sid, project: r.cwd ? path.basename(r.cwd) : 'session', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 });
  row.input += u.input_tokens || 0; row.cacheRead += u.cache_read_input_tokens || 0;
  row.cacheWrite += u.cache_creation_input_tokens || 0; row.output += u.output_tokens || 0;
  row.cost += costOf(r.message.model, u);
}
function ledgerOf(file) {
  const L = ledgers.get(file) || { size: 0, carry: '', seen: new Set(), days: {} };
  const size = fs.statSync(file).size;
  if (size > L.size) {
    const fd = fs.openSync(file, 'r');
    try {
      for (let pos = L.size; pos < size;) {
        const buf = Buffer.alloc(Math.min(8 << 20, size - pos));
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (!n) break;
        pos += n;
        const lines = (L.carry + buf.toString('utf8', 0, n)).split('\n');
        L.carry = lines.pop();
        for (const l of lines) addToLedger(L, l);
      }
    } finally { fs.closeSync(fd); }
    L.size = size;
    ledgers.set(file, L);
  }
  return L;
}
/** Today's payroll (per session) and this week's total, from every transcript touched in the last 8 days. */
function costs() {
  const now = Date.now(), today = mytDayOf(now), myt = now + 8 * 3600e3, dow = (new Date(myt).getUTCDay() + 6) % 7;
  const weekDays = new Set(Array.from({ length: dow + 1 }, (_, k) => mytDayOf(now - k * 86400e3)));
  const payroll = new Map();
  let week = 0, todayCost = 0;
  for (const { file } of recentTranscripts(8 * 86400e3)) {
    const L = ledgerOf(file);
    for (const [day, rows] of Object.entries(L.days)) {
      if (!weekDays.has(day)) continue;
      for (const row of Object.values(rows)) {
        week += row.cost;
        if (day !== today) continue;
        todayCost += row.cost;
        const p = payroll.get(row.id) || { ...row, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
        for (const k of ['input', 'cacheRead', 'cacheWrite', 'output', 'cost']) p[k] += row[k];
        payroll.set(row.id, p);
      }
    }
  }
  return { payroll: [...payroll.values()].sort((a, b) => b.cost - a.cost), cost: { today: todayCost, week } };
}

// ------------------------------------------------------------------ phone alerts: when a Claude needs you
// Hook events become Web Push alerts through the relay: a permission prompt or a question right away, a finished
// turn only when it ran for at least 45 seconds (short answers you are watching anyway). Same alert at most every 30 s.
const turnStart = new Map(), lastAlert = new Map();
const minutes = (ms) => (ms < 60e3 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60e3)} min`);
export function alertFor(j, prev, waiting, started, now = Date.now()) {
  if (!waiting || waiting === prev) return null;
  const project = j.cwd ? path.basename(j.cwd) : 'session', tag = `${j.session_id}:${waiting}`;
  if (waiting === 'permission') return { title: `Claude · ${project}`, body: j.message || 'needs your OK on a permission prompt', tag };
  if (waiting === 'input') return { title: `Claude · ${project}`, body: j.message || 'is waiting for your input', tag };
  const took = now - (started || now);
  if (took < 45e3) return null;
  const said = String(j.last_assistant_message || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return { title: `Claude · ${project} is done`, body: `Finished after ${minutes(took)}${said ? `: ${said}` : ''}`, tag };
}
function alertOnHook(j, prev) {
  const sid = j.session_id;
  if (!sid) return;
  if (j.hook_event_name === 'UserPromptSubmit') turnStart.set(sid, Date.now());
  const message = alertFor(j, prev, hookWait.get(sid)?.waiting, turnStart.get(sid));
  if (!message || Date.now() - (lastAlert.get(message.tag) || 0) < 30e3) return;
  lastAlert.set(message.tag, Date.now());
  relayPost('/push/send', message).catch((e) => console.log(`alert: ${e.message}`));
}
async function relayPost(route, body) {
  if (!PUSH?.pushUrl || !PUSH?.pushToken || !control.live) return null;
  const r = await fetch(`${new URL(PUSH.pushUrl).origin}${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${PUSH.pushToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`relay said HTTP ${r.status}`);
  return r;
}

// ------------------------------------------------------------------ the weekly report (Monday to now, MYT)
let reportCache = { at: 0, data: null };
async function report(ids) {
  if (reportCache.data && Date.now() - reportCache.at < 10 * 60e3) return reportCache.data;
  reportCache.at = Date.now();
  const now = Date.now(), myt = now + 8 * 3600e3, dow = (new Date(myt).getUTCDay() + 6) % 7;
  const from = now - (myt % 86400e3) - dow * 86400e3; // Monday 00:00 MYT
  const uses = [], errors = new Set(), sessionIds = new Set();
  for (const { file } of recentTranscripts(now - from + 3600e3)) for (const l of tailLines(file, 1 << 20)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(r.timestamp);
    if (!ts || ts < from) continue;
    if (r.sessionId && r.type === 'assistant') sessionIds.add(r.sessionId);
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (c.type === 'tool_use') uses.push({ id: c.id, name: c.name, input: c.input || {}, ts });
      if (c.type === 'tool_result' && c.is_error === true) errors.add(c.tool_use_id);
    }
  }
  const calls = {}, fails = {}, files = {}, days = [0, 0, 0, 0, 0, 0, 0];
  for (const u of uses) {
    const who = charFor(u.name, u.input, ids);
    calls[who] = (calls[who] || 0) + 1;
    if (errors.has(u.id)) fails[who] = (fails[who] || 0) + 1;
    days[Math.min(6, Math.floor((u.ts - from) / 86400e3))]++;
    const f = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(u.name) && (u.input.file_path || u.input.notebook_path);
    if (f) { const short = String(f).split('/').slice(-2).join('/'); files[short] = (files[short] || 0) + 1; }
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const log = WL_DIR ? await run('git', ['-C', WL_DIR, 'log', `--since=${new Date(from).toISOString()}`, '--numstat', '--format=%x1e%s'], WL_DIR) : null;
  const commits = String(log || '').split('\x1e').filter((b) => b.trim());
  const perFeature = {};
  for (const b of commits) for (const id of new Set(Object.keys(heatFrom(b)))) perFeature[id] = (perFeature[id] || 0) + 1;
  reportCache.data = {
    week: isoWeek(now), from, calls: top(calls, 12), failures: top(fails, 6), files: { count: Object.keys(files).length, top: top(files, 8) },
    sessions: sessionIds.size, days, commits: { total: commits.length, perFeature },
    dundies: [...(dundieStore.history || []), dundieStore.today].filter((d) => d && Date.parse(`${d.day}T00:00:00+08:00`) >= from),
  };
  return reportCache.data;
}

// ------------------------------------------------------------------ hooks: Claude Code tells the server straight away
// scripts/install-hooks.sh adds async hooks that POST each event here. They make the office react at once and
// say what the transcript can't: a session waiting on a permission prompt.
const hookWait = new Map(); // session -> { waiting, at }
const hookMode = new Map(); // session -> { mode, effort, at }: fresher than the transcript
const streams = new Set();
export function hookEvent(j, at = Date.now()) {
  const sid = j.session_id;
  if (!sid) return;
  if (j.permission_mode) hookMode.set(sid, { mode: j.permission_mode, effort: j.effort, at });
  const e = j.hook_event_name;
  if (e === 'Notification') {
    const kind = j.notification_type || (/permission/i.test(j.message || '') ? 'permission_prompt' : 'idle_prompt');
    if (kind === 'permission_prompt') hookWait.set(sid, { waiting: 'permission', at });
    else if (['idle_prompt', 'elicitation_dialog', 'agent_needs_input'].includes(kind)) hookWait.set(sid, { waiting: 'input', at });
  } else if (e === 'Stop') hookWait.set(sid, { waiting: 'reply', at });
  else if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostCompact'].includes(e)) hookWait.set(sid, { waiting: null, at });
  return hookWait.get(sid);
}
function withHooks(sessions, now = Date.now()) {
  for (const s of sessions) {
    const m = hookMode.get(s.id);
    if (m && now - m.at < 3600e3) { s.mode = m.mode; if (m.effort) s.effort = typeof m.effort === 'string' ? m.effort : m.effort.level || s.effort; }
    const h = hookWait.get(s.id);
    if (!h || now - h.at > 3600e3) continue;
    s.waiting = h.waiting;
    if (h.waiting) s.busy = false;
  }
  return sessions;
}

// ------------------------------------------------------------------ HR: weekly plugin picks
// Candidates come from the plugin marketplaces Claude Code already downloaded (~/.claude/plugins/marketplaces),
// scored against what you actually did this week: file types you edited, commands you ran, the packages in
// your projects and the tools you leaned on. A small per-week jitter rotates near-ties, so the line-up
// changes every Monday (MYT) even when your work doesn't.
export function marketplace() {
  const dir = path.join(CLAUDE, 'plugins/marketplaces');
  const known = readJson(path.join(CLAUDE, 'plugins/known_marketplaces.json')) || {};
  const out = [];
  for (const m of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const j = readJson(path.join(dir, m, '.claude-plugin/marketplace.json'));
    const repo = sourceUrl(known[m]?.source);
    for (const p of j?.plugins || []) {
      out.push({
        skills: !!p.skills, lsp: !!p.lspServers,
        url: webUrl(p.homepage) || sourceUrl(p.source, repo) || repo,
        name: p.name, marketplace: j.name || m, displayName: p.displayName, description: String(p.description || '').slice(0, 240),
        category: p.category || 'other', author: typeof p.author === 'string' ? p.author : p.author?.name,
        text: [p.name, p.displayName, p.description, p.category, ...(p.keywords || []), ...(p.tags || [])].join(' ').toLowerCase(),
      });
    }
  }
  return out;
}
export function isoWeek(now = Date.now()) {
  const d = new Date(now + 8 * 3600e3); // MYT calendar date
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400e3 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
const EXT_KW = { ts: ['typescript', 'javascript'], tsx: ['typescript', 'react', 'frontend'], js: ['javascript', 'node'], jsx: ['react', 'frontend'], mjs: ['javascript', 'node'], py: ['python'], swift: ['swift', 'ios'], kt: ['kotlin', 'android'], go: ['go'], rs: ['rust'], sql: ['sql', 'database', 'postgres'], html: ['web', 'frontend', 'html'], css: ['css', 'frontend', 'design'], md: ['documentation', 'docs'], json: ['api'], pdf: ['pdf', 'documents'], glb: ['3d'] };
const CMD_KW = { git: ['git', 'github', 'commit'], gh: ['github', 'pull request'], npm: ['javascript', 'node'], npx: ['javascript', 'node'], node: ['node'], expo: ['expo', 'mobile', 'react native'], eas: ['expo', 'mobile', 'deploy'], wrangler: ['cloudflare', 'deploy'], docker: ['docker', 'container'], python3: ['python'], pip: ['python'], psql: ['postgres', 'database'], supabase: ['supabase', 'database'], curl: ['api', 'http'], xcodebuild: ['ios', 'xcode'], vercel: ['vercel', 'deploy'], kubectl: ['kubernetes'], terraform: ['terraform', 'infrastructure'] };
const DEP_KW = ['supabase', 'sentry', 'expo', 'react', 'stripe', 'firebase', 'prisma', 'next', 'tailwind', 'postgres', 'redis', 'mongodb', 'graphql', 'vite', 'vercel', 'netlify', 'cloudflare', 'playwright', 'jest', 'vitest', 'revenuecat', 'posthog', 'notifications', 'pdf', 'camera'];
export function profileFrom(uses, deps = []) {
  const kw = new Map();
  const bump = (k, n = 1) => kw.set(k, (kw.get(k) || 0) + n);
  for (const u of uses) {
    const f = String(u.input?.file_path || u.input?.path || '');
    const ext = f.includes('.') ? f.split('.').pop().toLowerCase() : '';
    for (const k of EXT_KW[ext] || []) bump(k);
    if (u.name === 'Bash') for (const seg of String(u.input?.command || '').split(/&&|\|\||;|\|/)) for (const k of CMD_KW[seg.trim().split(/\s+/)[0]] || []) bump(k);
    if (u.name.startsWith('mcp__plugin_playwright') || u.name.startsWith('mcp__claude-in-chrome')) { bump('browser'); bump('testing'); }
    if (u.name === 'WebSearch' || u.name === 'WebFetch') { bump('search'); bump('web'); }
  }
  // a library the project depends on is a strong signal, even if this week's edits never named it
  for (const k of DEP_KW) if (deps.some((d) => d.includes(k))) bump(k, 400);
  return kw;
}
const GENERIC = new Set(['api', 'web', 'javascript', 'node', 'http', 'typescript', 'docs', 'documentation', 'testing', 'search', 'react', 'frontend', 'python']);
export function scorePlugins(list, kw, week, installed, perCategory = 2, n = 8) {
  const jitter = (name) => ([...`${week}:${name}`].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381) % 1000) / 1000;
  const scored = list.filter((p) => !installed.has(p.name)).map((p) => {
    const hits = [];
    let score = 0;
    for (const [k, c] of kw) {
      if (!new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(p.text)) continue;
      const w = Math.log2(1 + c) * (p.name.includes(k) ? 2 : 1) * (GENERIC.has(k) ? 0.4 : 1);
      score += w;
      hits.push([k, w]);
    }
    return { ...p, score: score + jitter(p.name) * 1.5, why: hits.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k) };
  }).filter((p) => p.why.length).sort((a, b) => b.score - a.score);
  const per = new Map(), out = [];
  for (const p of scored) {
    if ((per.get(p.category) || 0) >= perCategory) continue;
    per.set(p.category, (per.get(p.category) || 0) + 1);
    out.push(p);
    if (out.length >= n) break;
  }
  return out.map(({ text, score, ...p }) => ({ ...p, install: `/plugin install ${p.name}@${p.marketplace}`, ...pluginProsCons(p) }));
}
// Pros and cons from what the marketplace says about a plugin: who made it, what it fits, what it costs you.
export function pluginProsCons(p) {
  const pros = [], cons = [];
  const author = String(p.author || ''), d = String(p.description || '').toLowerCase(), word = author.toLowerCase().split(/[\s,.]+/)[0];
  if (/anthropic/i.test(author)) pros.push('made by Anthropic');
  else if (word && word.length > 2 && String(p.url || '').toLowerCase().includes(word)) pros.push(`official plugin from ${author}`);
  else cons.push('community-made: read it before installing');
  if (p.why?.length) pros.push(`fits your ${p.why.slice(0, 2).join(' and ')} work`);
  if (p.skills) pros.push('brings skills Claude picks up when relevant');
  if (p.lsp) pros.push('adds code intelligence (LSP) for that language');
  if (/\bmcp\b|mcp server|model context protocol/.test(d)) cons.push('adds MCP tools to every session: more context used');
  if (/account|api key|token|subscription|sign[ -]?in|log[ -]?in|paid|enterprise|workspace/.test(d)) cons.push(`needs an account with ${author || 'the service'}`);
  if (/beta|preview|experimental/.test(d)) cons.push('still in beta');
  if (pros.length < 2 && /automat|generat|review|test|deploy|debug/.test(d)) pros.push('saves repetitive work');
  return { pros: pros.slice(0, 3), cons: cons.slice(0, 3) };
}
let hrCache = { at: 0, week: '', data: null };
function hr(chars) {
  const week = isoWeek();
  if (hrCache.data && hrCache.week === week && Date.now() - hrCache.at < 3600e3) return hrCache.data;
  const market = marketplace();
  const installed = new Set(chars.map((c) => c.id));
  const files = recentTranscripts(7 * 86400e3);
  const uses = [], wlUses = [], cwds = new Set();
  for (const { file } of files) for (const l of tailLines(file, 256 * 1024)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.cwd) cwds.add(r.cwd);
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) if (c.type === 'tool_use') {
      uses.push({ name: c.name, input: c.input || {} });
      if (WL?.root && String(r.cwd || '').includes(WL.root)) wlUses.push({ name: c.name, input: c.input || {} });
    }
  }
  const deps = [];
  for (const cwd of cwds) { const pk = readJson(path.join(cwd, 'package.json')); deps.push(...Object.keys({ ...pk?.dependencies, ...pk?.devDependencies })); }
  const kw = profileFrom(uses, deps);
  const byName = new Map(market.map((p) => [p.name, p]));
  const pickFor = (keywords, n) => scorePlugins(market, new Map(keywords.map((k) => [k, 3])), week, installed, 1, n);
  const picks = scorePlugins(market, kw, week, installed);
  const wlPk = readJson(path.join(WL_DIR || '', 'package.json'));
  const wlKw = profileFrom(wlUses, Object.keys({ ...wlPk?.dependencies, ...wlPk?.devDependencies }));

  const inOffices = (WL?.features || []).flatMap((f) => f.plugins);
  // each HR room with plugins: scored on its keywords (the HQ room also on its code)
  const taken = new Set([...installed, ...inOffices, ...picks.map((p) => p.name)]);
  const roomPlugins = {};
  for (const r of HR_ROOMS) {
    if (!r.plugins) continue;
    const k = new Map((r.plugins.keywords || []).map((w) => [w, 3]));
    if (r.plugins.profile === 'wl') for (const [w, c] of wlKw) k.set(w, (k.get(w) || 0) + c);
    // a room may keep to marketplace categories ("design"), so a keyword like "design" in a database plugin doesn't count
    const pool = r.plugins.categories ? market.filter((p) => r.plugins.categories.includes(p.category)) : market;
    roomPlugins[r.id] = scorePlugins(pool, k, `${week}:${r.id}`, taken, r.plugins.categories ? 6 : 2, r.plugins.n || r.n || 6);
    for (const p of roomPlugins[r.id]) taken.add(p.name);
  }
  const data = {
    week,
    picks,
    roomPlugins,
    rooms: Object.fromEntries((WL?.future || []).map((r) => [r.id, pickFor(r.keywords, 3)])),
    features: Object.fromEntries((WL?.features || []).map((f) => [f.id, f.plugins.filter((n) => byName.has(n) && !installed.has(n)).map((n) => {
      const p = byName.get(n);
      return { name: n, description: p.description, install: `/plugin install ${n}@${p.marketplace}`, url: p.url, ...pluginProsCons(p) };
    })])),
  };
  hrCache = { at: Date.now(), week, data };
  return data;
}
function hrState(chars) {
  const d = hr(chars);
  refreshSearches(d.week);
  const rooms = { ...d.rooms }, seen = new Set();
  for (const r of HR_ROOMS) {
    const lists = [d.roomPlugins[r.id] || [], ...(r.mcp || []).map((t) => searched.terms[`mcp:${t}`] || []), ...(r.repos || []).map((t) => searched.terms[`repo:${t}`] || [])]
      .map((l) => l.filter((p) => !seen.has(p.name)));
    rooms[r.id] = roundRobin(lists.filter((l) => l.length), d.week, r.n || 6);
    for (const p of rooms[r.id]) seen.add(p.name);
  }
  const { roomPlugins, ...rest } = d;
  return { ...rest, rooms };
}

// ------------------------------------------------------------------ HR rooms: MCP servers and repos, weekly
// The rooms are the careers fair (fair in cast.json) and the HQ's own HR wing (hr in private/hq.json). MCP servers and repos
// come from GitHub search (most stars first): MCP servers are repos named, tagged or described as MCP. Searched
// once a week, one at a time, through the gh CLI when it is signed in (its token stays in gh), otherwise
// anonymously; kept on disk. A weekly shuffle picks across each room's terms.
const HR_ROOMS = [...(WL?.hr || []), ...(cast.fair || [])];
const SEARCH_FILE = path.join(os.homedir(), '.config/clawd-mifflin/hr-search.json');
let searched = readJson(SEARCH_FILE) || { week: '', terms: {} };
let searchBusy = false, searchTried = 0;
const weekJitter = (week, name) => [...`${week}:${name}`].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381) % 1000;
export function roundRobin(lists, week, n) {
  // the best few of each list, shuffled by week, then one list at a time
  const depth = Math.max(3, Math.ceil(n / Math.max(1, lists.length)));
  const sorted = lists.map((l) => l.slice(0, depth).sort((a, b) => weekJitter(week, a.name) - weekJitter(week, b.name)));
  const out = [], seen = new Set();
  for (let k = 0; out.length < n && k < depth; k++) for (const l of sorted) {
    const p = l[k];
    if (p && !seen.has(p.name) && out.length < n) { seen.add(p.name); out.push(p); }
  }
  return out;
}
export const isMcpRepo = (r) => /mcp/i.test(r.name) || (r.topics || []).some((t) => /^mcp|model-context-protocol/.test(t)) || /\bMCP\b|model context protocol/i.test(r.description || '');
const kilo = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
// Pros and cons from what GitHub knows: how many use it, how alive it is, the licence, who keeps it.
export function repoProsCons(r, now = Date.now()) {
  const pros = [], cons = [];
  const stars = r.stargazers_count || 0, days = (now - Date.parse(r.pushed_at || 0)) / 864e5;
  const lic = r.license?.spdx_id, text = `${r.name} ${r.description || ''}`.toLowerCase();
  if (stars >= 1000) pros.push(`${kilo(stars)} stars: widely used`);
  else if (stars >= 100) pros.push(`${stars} stars: an active community`);
  else cons.push(`only ${stars} stars: little community testing`);
  if (days < 30) pros.push('updated in the last month');
  else if (days > 365) cons.push(`no updates for ${Math.floor(days / 30)} months`);
  else if (days > 180) cons.push('quiet for over half a year');
  if (!lic || lic === 'NOASSERTION') cons.push('no clear licence: check before using it at work');
  else if (/GPL/.test(lic)) cons.push(`${lic}: copyleft, careful in closed-source work`);
  else pros.push(`${lic} licence: fine for work use`);
  if (r.owner?.type === 'Organization') pros.push(`kept by an organisation (${r.owner.login})`);
  else cons.push('a one-person project');
  if ((r.open_issues_count || 0) > 300) cons.push(`${r.open_issues_count} open issues`);
  if (/revit|navisworks|solidworks|dynamo|autocad|rhino/.test(text)) cons.push('needs the desktop app running (Revit and Navisworks are Windows-only)');
  if (/api[ -]?key|access token|subscription|paid plan/.test(text)) cons.push('needs an API key or account');
  if (/[\u4e00-\u9fff]/.test(r.description || '')) cons.push('docs mostly in Chinese');
  return { pros: pros.slice(0, 3), cons: cons.slice(0, 3) };
}
export function repoCandidate(r, term, mcp = false, now = Date.now()) {
  const npm = /npmjs\.com\/package\/(.+)$/.exec(r.homepage || '')?.[1];
  const pc = repoProsCons(r, now);
  if (mcp && npm) pc.pros.unshift('one-line install with npx');
  return {
    name: r.full_name, displayName: r.name, description: `${String(r.description || '').slice(0, 200)} ★ ${kilo(r.stargazers_count || 0)}`.trim(),
    category: mcp ? 'MCP server' : 'GitHub repo', author: r.owner?.login, why: [term],
    install: mcp && npm ? `claude mcp add ${r.name} -- npx -y ${npm}` : `git clone ${r.clone_url}`,
    url: r.html_url, homepage: webUrl(r.homepage), pros: pc.pros.slice(0, 3), cons: pc.cons,
  };
}
function searchRepos(q) {
  const args = ['api', '-X', 'GET', 'search/repositories', '-f', `q=${q}`, '-f', 'sort=stars', '-f', 'per_page=15'];
  return new Promise((resolve) => execFile('gh', args, { timeout: 20000 }, async (err, out) => {
    if (!err) { try { return resolve(JSON.parse(out).items || []); } catch { /* fall through */ } }
    try {
      const r = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=15`, { headers: { 'user-agent': 'clawd-mifflin' }, signal: AbortSignal.timeout(20000) });
      resolve(r.ok ? (await r.json()).items || [] : null);
    } catch { resolve(null); }
  }));
}
async function refreshSearches(week) {
  if (searchBusy || searched.week === week || !control.live || Date.now() - searchTried < 3600e3) return;
  searchBusy = true; searchTried = Date.now();
  try {
    const usable = (r) => !r.archived && !r.fork && r.owner?.login !== 'MikachuFM2202';
    const keys = [...new Set(HR_ROOMS.flatMap((r) => [...(r.mcp || []).map((t) => `mcp:${t}`), ...(r.repos || []).map((t) => `repo:${t}`)]))];
    const terms = {};
    let answered = 0;
    for (const key of keys) {
      const [kind, term] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const items = await searchRepos(kind === 'mcp' && !/mcp/i.test(term) ? `${term} mcp` : term);
      if (items) answered++;
      terms[key] = (items || []).filter((r) => usable(r) && (kind === 'mcp' ? isMcpRepo(r) : !isMcpRepo(r))).slice(0, 5).map((r) => repoCandidate(r, term, kind === 'mcp'));
      await new Promise((ok) => setTimeout(ok, 2200)); // GitHub allows 30 searches a minute
    }
    // most searches answered: done for the week; otherwise keep what came back and try again in an hour
    searched = { week: answered >= keys.length / 2 ? week : searched.week, terms: { ...searched.terms, ...Object.fromEntries(Object.entries(terms).filter(([, l]) => l.length)) } };
    fs.mkdirSync(path.dirname(SEARCH_FILE), { recursive: true });
    fs.writeFileSync(SEARCH_FILE, JSON.stringify(searched));
    stateCache.at = 0;
  } catch (e) {
    console.log(`HR search: ${e.message}`);
  } finally { searchBusy = false; }
}

// Each HQ feature office links to its code on GitHub (the first of its paths that exists).
let wlLinkCache = null;
function wlLinks() {
  if (wlLinkCache || !WL_DIR || !WL?.repo) return wlLinkCache || {};
  wlLinkCache = {};
  for (const f of WL.features) {
    for (const pre of f.paths) {
      const full = path.join(WL_DIR, pre), dir = pre.endsWith('/') ? full : path.dirname(full);
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) { wlLinkCache[f.id] = `${WL.repo}/tree/main/${pre.replace(/\/$/, '')}`; break; }
      const hit = fs.existsSync(dir) && fs.readdirSync(dir).sort().find((n) => n.startsWith(path.basename(full)));
      if (hit) { wlLinkCache[f.id] = `${WL.repo}/${fs.statSync(path.join(dir, hit)).isDirectory() ? 'tree' : 'blob'}/main/${path.relative(WL_DIR, path.join(dir, hit))}`; break; }
    }
    wlLinkCache[f.id] ||= WL.repo;
  }
  return wlLinkCache;
}

// ------------------------------------------------------------------ Spotify: your account (Web API), or the Mac app (AppleScript)
// Connected (Authorization Code with PKCE, no client secret): what you play on any device, phone included, with
// album art; controls need Spotify Premium. Not connected: the Spotify app on this Mac, through AppleScript.
// Tokens live in ~/.config/clawd-mifflin/spotify.json (mode 600) and never leave this process.
const SPOTIFY_FILE = path.join(os.homedir(), '.config/clawd-mifflin/spotify.json');
const SPOTIFY_REDIRECT = `http://127.0.0.1:${PORT}/api/spotify/callback`;
const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
let spotifyAuth = readJson(SPOTIFY_FILE);
const spotifyClient = () => PUSH?.spotifyClientId || spotifyAuth?.clientId;
const pkcePending = new Map(); // state -> { verifier, at }
export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}
function spotifySave(a) {
  spotifyAuth = a;
  fs.mkdirSync(path.dirname(SPOTIFY_FILE), { recursive: true });
  if (a) fs.writeFileSync(SPOTIFY_FILE, JSON.stringify(a), { mode: 0o600 });
  else fs.rmSync(SPOTIFY_FILE, { force: true });
}
async function spotifyToken(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
  return j;
}
async function spotifyAccess() {
  if (!spotifyAuth?.refreshToken) return null;
  if (spotifyAuth.accessToken && Date.now() < spotifyAuth.expiresAt - 60000) return spotifyAuth.accessToken;
  try {
    const j = await spotifyToken({ grant_type: 'refresh_token', refresh_token: spotifyAuth.refreshToken, client_id: spotifyAuth.clientId });
    spotifySave({ ...spotifyAuth, accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000, refreshToken: j.refresh_token || spotifyAuth.refreshToken });
    return spotifyAuth.accessToken;
  } catch (e) {
    if (/invalid_grant|revoked/i.test(e.message)) spotifySave(null); // access was removed in Spotify: back to the Mac app
    return null;
  }
}
async function spotifyApi(method, p) {
  const token = await spotifyAccess();
  if (!token) return { status: 401 };
  const r = await fetch(`https://api.spotify.com/v1${p}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* empty */ }
  return { status: r.status, j };
}
/** Pure: Spotify's player answer -> what the office shows. Exported for the test. */
export function playerInfo(j) {
  if (!j?.item) return { connected: true, running: !!j?.device, playing: false };
  const it = j.item, art = it.album?.images || it.images || [];
  return {
    connected: true, running: true, playing: !!j.is_playing, track: it.name,
    artist: (it.artists || []).map((a) => a.name).join(', ') || it.show?.name || '', album: it.album?.name,
    art: (art.find((i) => i.width <= 320) || art[0])?.url, url: it.external_urls?.spotify,
    device: j.device?.name, progress: j.progress_ms, duration: it.duration_ms, at: Date.now(),
  };
}
const SPOTIFY = 'application id "com.spotify.client"';
const osa = (lines) => new Promise((resolve) => execFile('osascript', lines.flatMap((l) => ['-e', l]), { timeout: 4000 }, (err, out) => resolve(err ? null : String(out).trim())));
let musicCache = { at: 0, data: null };
async function music(fresh = false) {
  if (!control.live) return null;
  if (!fresh && Date.now() - musicCache.at < 5000) return musicCache.data;
  musicCache.at = Date.now();
  if (spotifyAuth?.refreshToken) {
    const r = await spotifyApi('GET', '/me/player?additional_types=episode');
    if (r.status === 200 || r.status === 204) return (musicCache.data = playerInfo(r.j));
    if (r.status !== 401) return musicCache.data; // a hiccup: keep the last answer
  }
  if (process.platform !== 'darwin') return (musicCache.data = null);
  // "is running" is answered without launching Spotify, so a closed Spotify stays closed
  const out = await osa([`if ${SPOTIFY} is running then`, `tell ${SPOTIFY}`, 'try',
    'return (player state as text) & tab & (name of current track) & tab & (artist of current track) & tab & (spotify url of current track)',
    'on error', 'return (player state as text)', 'end try', 'end tell', 'end if', 'return "off"']);
  const [st, track, artist, uri] = (out || 'off').split('\t');
  musicCache.data = st === 'off' ? { running: false } : { running: true, playing: st === 'playing', track, artist,
    url: uri?.startsWith('spotify:track:') ? `https://open.spotify.com/track/${uri.split(':')[2]}` : undefined };
  return musicCache.data;
}
const SPOTIFY_CMD = { playpause: 'playpause', next: 'next track', previous: 'previous track' };

// ------------------------------------------------------------------ usage
// Real plan usage, the same numbers /usage shows. The OAuth token stays in this process.
// The endpoint rate-limits (HTTP 429), so: at most once a minute, back off 5 minutes after a 429, and keep
// the last good numbers on disk so a restart doesn't ask again straight away.
const USAGE_FILE = path.join(os.homedir(), '.config/clawd-mifflin/usage-cache.json');
let usageCache = readJson(USAGE_FILE) || { at: 0, data: null };
let usageBackoff = 0;
function credentials() {
  return new Promise((resolve) => {
    const file = readJson(path.join(CLAUDE, '.credentials.json'));
    if (file) return resolve(file);
    if (process.platform !== 'darwin') return resolve(null);
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (err, out) => {
      try { resolve(err ? null : JSON.parse(out)); } catch { resolve(null); }
    });
  });
}
async function usage() {
  if (!control.live || Date.now() - usageCache.at < 60000 || Date.now() < usageBackoff) return usageCache.data;
  usageCache.at = Date.now();
  try {
    const token = (await credentials())?.claudeAiOauth?.accessToken;
    if (!token) throw new Error('no token');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 429) usageBackoff = Date.now() + 5 * 60 * 1000;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // resets_at has microseconds, which Safari's Date cannot parse: normalise to plain ISO
    const pick = (w) => w && { pct: w.utilization, resetsAt: w.resets_at && new Date(w.resets_at).toISOString() };
    usageCache.data = { session: pick(j.five_hour), weekly: pick(j.seven_day), source: 'anthropic', at: Date.now() };
    try { fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(usageCache), { mode: 0o600 }); } catch { /* cache only */ }
  } catch (e) {
    usageCache.data = { ...(usageCache.data || {}), error: String(e.message || e) }; // last good numbers stay
  }
  return usageCache.data;
}

// One computed state shared by every open tab for 2 s, so several tabs don't re-read the transcripts.
let stateCache = { at: 0, p: null };
function cachedState(fresh) {
  if (fresh && Date.now() - usageCache.at > 30000) usageCache.at = 0; // refresh button, at most every 30 s (the endpoint rate-limits)
  if (fresh || !stateCache.p || Date.now() - stateCache.at > 2000) stateCache = { at: Date.now(), p: state() };
  return stateCache.p;
}

async function state() {
  const chars = roster();
  const ids = new Set(chars.map((c) => c.id));
  const act = liveActivity(ids);
  // Characters seen at work but not in the roster (new connectors etc.) get hired on the spot.
  for (const id of Object.keys(act.status)) {
    if (!ids.has(id) && !id.startsWith('wl-')) chars.push({ ...(castById[id] || {}), id, name: castById[id]?.name || id, kind: castById[id]?.kind || 'mcp', enabled: true, vendor: castById[id]?.vendor || 'other', known: !!castById[id] });
  }
  withHooks(act.sessions);
  const [deliveries, ci, wlHeat, rep, mus, use] = await Promise.all([commits(), builds(), heat(), report(ids), music(), usage()]);
  const [career, branchList] = await Promise.all([careers(ids), branches()]);
  const money = costs(); // complete transcripts, not just the tails: replaces the activity's payroll
  return { live: true, now: Date.now(), machine: PUSH?.machine, hq: WL || undefined, characters: chars, ...act, payroll: money.payroll, cost: money.cost, dundies: dundiesFor(act.replay), deliveries, builds: ci, heat: wlHeat, report: rep, careers: career, branches: branchList, hr: hrState(chars), wlLinks: wlLinks(), music: mus, usage: use };
}

// ------------------------------------------------------------------ push to the online office
// With ~/.config/clawd-mifflin/config.json ({ pushUrl, pushToken }) the server sends its state to the
// Cloudflare relay, so the GitHub Pages site can show it live behind a password. It sends when something
// changed (checked every 4 s) and at least once a minute, so viewers can tell the Mac is still on.
const CONFIG = path.join(os.homedir(), '.config/clawd-mifflin/config.json');
const PUSH = readJson(CONFIG);
// The live switch on the page: off means no usage requests and nothing pushed, until it is switched back on.
const control = { live: PUSH?.live !== false };
function setLive(on) {
  control.live = on;
  if (PUSH) { PUSH.live = on; fs.writeFileSync(CONFIG, JSON.stringify(PUSH, null, 1), { mode: 0o600 }); }
  lastPush.sig = ''; // send the change right away
}
let lastPush = { at: 0, sig: '' }, pushFailing = false, lastState = null, pushBusy = false;
async function pushSoon() { if (pushBusy) return; pushBusy = true; try { await push(); } finally { pushBusy = false; } }
async function push() {
  const s = control.live ? (lastState = await cachedState(false))
    : { ...(lastState || (await cachedState(false))), paused: true, now: Date.now(), status: {}, subagents: [], failures: [], sessions: [], replay: [], deliveries: [], builds: [] };
  const sig = JSON.stringify({ ...s, now: 0, usage: { ...s.usage, at: 0 } });
  if (sig === lastPush.sig && Date.now() - lastPush.at < 60000) return;
  try {
    const r = await fetch(PUSH.pushUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${PUSH.pushToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...s, branches: undefined, relayed: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lastPush = { at: Date.now(), sig };
    if (pushFailing) console.log('push: back online');
    pushFailing = false;
  } catch (e) {
    if (!pushFailing) console.log(`push failed (will keep trying): ${e.message}`);
    pushFailing = true;
  }
}

// ------------------------------------------------------------------ main
const TYPES = { '.webmanifest': 'application/manifest+json', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml' };

// The demo is sealed with a password (PBKDF2 + AES-GCM), so the public site shows nothing until it is entered.
export async function seal(obj, password, iterations = 250000) {
  const enc = new TextEncoder(), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const b64 = (u) => Buffer.from(u).toString('base64');
  return { v: 1, iterations, salt: b64(salt), iv: b64(iv), data: b64(data) };
}
/** Strip everything private from a state, for the public demo. Exported for the test. */
export function publicState(s) {
  const hqIds = new Set([...(s.hq?.future || []), ...(s.hq?.hr || [])].map((r) => r.id));
  const out = { ...s, live: false, events: [], status: {}, activeSessions: 0, counts: {}, sessions: [], subagents: [], failures: [], replay: [], payroll: [] };
  for (const k of ['hq', 'deliveries', 'builds', 'heat', 'report', 'dundies', 'music', 'wlLinks', 'careers', 'clashes', 'branches', 'machine', 'cost']) delete out[k];
  if (s.hr) out.hr = { week: s.hr.week, picks: s.hr.picks, rooms: Object.fromEntries(Object.entries(s.hr.rooms || {}).filter(([id]) => !hqIds.has(id))) };
  // memory: how many files per project, but neither project nor file names
  out.characters = s.characters.map((c) => (c.memory ? { ...c, memory: c.memory.map((m, k) => ({ project: `project ${k + 1}`, files: m.files.map(() => 'memory') })) } : c));
  return out;
}

if (process.argv.includes('--snapshot')) {
  const password = process.env.DEMO_PASSWORD || PUSH?.demoPassword;
  if (!password) { console.error('set demoPassword in ~/.config/clawd-mifflin/config.json (or DEMO_PASSWORD) first'); process.exit(1); }
  const s = publicState(await state());
  fs.writeFileSync(path.join(PUBLIC, 'state.enc'), JSON.stringify(await seal(s, password)));
  console.log(`wrote public/state.enc (${s.characters.length} characters, sealed with the demo password)`);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // Only this machine's own pages: reject other Host names (DNS rebinding) and, for writes, other origins.
    // A JSON content type also forces a CORS preflight, which this server never approves.
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); return res.end(); }
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if ((origin && new URL(origin).host !== host) || !String(req.headers['content-type'] || '').startsWith('application/json')) { res.writeHead(403); return res.end(); }
    }
    if (url.pathname === '/api/live') {
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1000) break; }
        try { setLive(JSON.parse(body).on !== false); } catch { res.writeHead(400); return res.end(); }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ live: control.live }));
    }
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      // this Mac's page switches alerts on through the server, which holds the relay's token
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8192) break; }
      // (the Host, Origin and JSON checks at the top of this handler already keep other sites out; forward only these fields)
      try {
        const { subscription: sub, on } = JSON.parse(body);
        const r = await relayPost('/push/subscribe', { subscription: { endpoint: String(sub?.endpoint || ''), keys: { p256dh: String(sub?.keys?.p256dh || ''), auth: String(sub?.keys?.auth || '') } }, on: on !== false });
        res.writeHead(r ? 204 : 503);
      }
      catch (e) { res.writeHead(502, { 'content-type': 'text/plain' }); return res.end(e.message); }
      return res.end();
    }
    if (url.pathname === '/api/digest' && req.method === 'POST') {
      try { const text = await sendDigest(); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ sent: true, text })); }
      catch (e) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ sent: false, error: e.message, text: digestText(await cachedState(false)) })); }
    }
    if (url.pathname === '/api/ifc') {
      const f = await ifcFile();
      if (url.searchParams.has('info')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(f ? { name: path.basename(f), size: fs.statSync(f).size } : null)); }
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    if (url.pathname === '/api/hook' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 256 * 1024) break; }
      try {
        const j = JSON.parse(body), prev = hookWait.get(j.session_id)?.waiting ?? null;
        hookEvent(j);
        alertOnHook(j, prev);
      } catch { res.writeHead(400); return res.end(); }
      // the transcript is written a moment after the hook fires: give it that moment, then tell everyone
      setTimeout(() => {
        stateCache.at = 0;
        for (const s of streams) s.write('data: tick\n\n');
        if (PUSH?.pushUrl && control.live) pushSoon();
      }, 400);
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/api/spotify/login') {
      const clientId = spotifyClient();
      if (!clientId) { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('Add spotifyClientId to ~/.config/clawd-mifflin/config.json first (see the README).'); }
      const verifier = randomBytes(48).toString('base64url'), state = randomBytes(16).toString('hex');
      pkcePending.set(state, { verifier, clientId, at: Date.now() });
      const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT, scope: SPOTIFY_SCOPES, state, code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier) });
      res.writeHead(302, { location: `https://accounts.spotify.com/authorize?${q}` });
      return res.end();
    }
    if (url.pathname === '/api/spotify/callback') {
      const p = pkcePending.get(url.searchParams.get('state'));
      pkcePending.delete(url.searchParams.get('state'));
      let msg = 'Spotify is connected.';
      if (!p || Date.now() - p.at > 10 * 60e3) msg = 'That sign-in link expired: try Connect again.';
      else if (url.searchParams.get('error')) msg = `Spotify said: ${url.searchParams.get('error')}`;
      else {
        try {
          const j = await spotifyToken({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: SPOTIFY_REDIRECT, client_id: p.clientId, code_verifier: p.verifier });
          spotifySave({ clientId: p.clientId, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 });
          musicCache.at = 0; stateCache.at = 0;
        } catch (e) { msg = `Could not connect: ${e.message}`; }
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Spotify</title><body style="font:16px system-ui;padding:40px"><p>${msg.replace(/[<>&]/g, '')}</p><p><a href="/">Back to the office</a></p><script>setTimeout(()=>location.href='/',1500)</script>`);
    }
    if (url.pathname === '/api/spotify') {
      let error = null;
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1000) break; }
        let cmd; try { cmd = JSON.parse(body).cmd; } catch { /* checked below */ }
        if (cmd === 'disconnect') spotifySave(null);
        else if (!SPOTIFY_CMD[cmd]) { res.writeHead(400); return res.end(); }
        else if (spotifyAuth?.refreshToken) {
          const now = await music(true);
          const [method, p] = cmd === 'next' ? ['POST', '/me/player/next'] : cmd === 'previous' ? ['POST', '/me/player/previous'] : now?.playing ? ['PUT', '/me/player/pause'] : ['PUT', '/me/player/play'];
          const r = await spotifyApi(method, p);
          if (r.status === 403) error = 'Controls need Spotify Premium.';
          else if (r.status === 404) error = 'No active device: start playing somewhere first.';
          else if (r.status >= 400) error = r.j?.error?.message || `Spotify said HTTP ${r.status}`;
        } else await osa([`tell ${SPOTIFY} to ${SPOTIFY_CMD[cmd]}`]);
        await new Promise((r) => setTimeout(r, 400));
        stateCache.at = 0;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ...(await music(true)), canConnect: !!spotifyClient(), error }));
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': hi\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname === '/api/state') {
      try {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(await cachedState(url.searchParams.has('fresh'))));
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
      return;
    }
    let file = path.join(PUBLIC, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`Clawd Mifflin is open: http://127.0.0.1:${PORT}`));
  setInterval(digestTick, 60000);
  if (PUSH?.pushUrl && PUSH?.pushToken) {
    console.log(`pushing live state to ${new URL(PUSH.pushUrl).host}`);
    setInterval(pushSoon, 4000);
  }
}
