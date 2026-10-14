// Clawd Mifflin relay: the Mac's server POSTs the office state here, the website GETs it with a password.
// One Durable Object holds the latest state, so every viewer sees the same thing.
import { DurableObject } from 'cloudflare:workers';

const MAX_BODY = 1 << 20; // 1 MB

export class Office extends DurableObject {
  async put(json, machine) {
    if (machine) {
      const s = JSON.parse(json);
      return s.remove ? this.ctx.storage.delete(`branch:${machine}`) : this.ctx.storage.put(`branch:${machine}`, branchSummary(s, machine)); // {"remove":true} closes a branch
    }
    this.latest = json;
    await this.ctx.storage.put('state', json);
  }
  async get() {
    this.latest ??= (await this.ctx.storage.get('state')) ?? null;
    if (!this.latest) return null;
    // other Macs ride along as branch offices
    const list = [...(await this.ctx.storage.list({ prefix: 'branch:' })).values()].filter((b) => Date.now() - b.at < 24 * 3600e3);
    if (!list.length) return this.latest;
    return JSON.stringify({ ...JSON.parse(this.latest), branches: list.map((b) => ({ ...b, offline: Date.now() - b.at > 3 * 60e3 })) });
  }
}

// A branch is kept small: who is in, what they are doing, the last few calls.
function branchSummary(s, machine) {
  return {
    machine, at: Date.now(), paused: !!s.paused,
    sessions: (s.sessions || []).slice(0, 5).map(({ id, project, busy, waiting, model, effort, mode }) => ({ id, project, busy, waiting, model, effort, mode })),
    status: Object.fromEntries(Object.entries(s.status || {}).filter(([, v]) => v.session).map(([k, v]) => [k, { tool: v.tool, session: v.session }])),
    events: (s.events || []).slice(0, 6).map(({ t, char, tool, error }) => ({ t, char, tool, error })),
  };
}

// Compare secrets in constant time (hash first so different lengths don't leak either).
async function same(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}
const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').includes(origin);
    const cors = allowed ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'origin' } : {};
    const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { 'cache-control': 'no-store', ...cors, ...extra } });
    if (req.method === 'OPTIONS') return reply(null, 204);
    if (new URL(req.url).pathname !== '/state') return reply('not found', 404);
    const office = env.OFFICE.get(env.OFFICE.idFromName('office-2')); // a fresh object since branches came in

    if (req.method === 'POST') {
      if (!(await same(bearer(req), env.PUSH_TOKEN))) return reply('unauthorized', 401);
      const body = await req.text();
      if (body.length > MAX_BODY) return reply('too large', 413);
      try { JSON.parse(body); } catch { return reply('bad json', 400); }
      const machine = new URL(req.url).searchParams.get('machine');
      if (machine && !/^[a-z0-9-]{1,32}$/i.test(machine)) return reply('bad machine name', 400);
      await office.put(body, machine);
      return reply(null, 204);
    }
    if (req.method === 'GET') {
      if (!(await same(bearer(req), env.VIEW_PASSWORD))) return reply('unauthorized', 401);
      const json = await office.get();
      return json ? reply(json, 200, { 'content-type': 'application/json' }) : reply('no state yet', 404);
    }
    return reply('method not allowed', 405);
  },
};
