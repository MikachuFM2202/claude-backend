// Clawd Mifflin relay: the Mac's server POSTs the office state here, the website GETs it with a password.
// One Durable Object holds the latest state, so every viewer sees the same thing.
import { DurableObject } from 'cloudflare:workers';
import { sendPush, validSubscription, vapidPublic } from './push.js';

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
  // phone alerts: one subscription per browser that switched Alerts on
  async subscribe(key, sub) { await this.ctx.storage.put(`push:${key}`, sub); }
  async unsubscribe(key) { await this.ctx.storage.delete(`push:${key}`); }
  async subscriptions() { return [...(await this.ctx.storage.list({ prefix: 'push:' })).entries()]; }
}

const PUSH_SUBJECT = 'https://mikachufm2202.github.io/claude-backend/';
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
/** Alert every subscribed browser; forget the ones the push service says are gone. */
async function alertAll(office, env, message) {
  const jwk = JSON.parse(env.VAPID_JWK);
  let sent = 0;
  for (const [key, sub] of await office.subscriptions()) {
    const status = await sendPush(sub, message, jwk, PUSH_SUBJECT).catch(() => 0);
    if (status === 404 || status === 410) await office.unsubscribe(key.slice(5));
    else if (status >= 200 && status < 300) sent++;
  }
  return sent;
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
    const route = new URL(req.url).pathname;
    const office = env.OFFICE.get(env.OFFICE.idFromName('office-2')); // a fresh object since branches came in
    if (route.startsWith('/push/')) {
      if (!env.VAPID_JWK) return reply('phone alerts are not set up', 503);
      if (route === '/push/key' && req.method === 'GET') return reply(JSON.stringify({ key: vapidPublic(JSON.parse(env.VAPID_JWK)) }), 200, { 'content-type': 'application/json' });
      const token = bearer(req);
      const mac = await same(token, env.PUSH_TOKEN);
      if (req.method !== 'POST' || !(mac || (await same(token, env.VIEW_PASSWORD)))) return reply('unauthorized', 401);
      const body = await req.text();
      if (body.length > 8192) return reply('too large', 413);
      let j; try { j = JSON.parse(body); } catch { return reply('bad json', 400); }
      if (route === '/push/subscribe') {
        // anyone with the live password (or the Mac) may switch alerts on or off for their own browser
        if (!validSubscription(j.subscription)) return reply('not a push subscription', 400);
        const key = await sha(j.subscription.endpoint);
        if (j.on === false) { await office.unsubscribe(key); return reply(null, 204); }
        const sub = { endpoint: j.subscription.endpoint, keys: { p256dh: j.subscription.keys.p256dh, auth: j.subscription.keys.auth } };
        await office.subscribe(key, sub);
        await sendPush(sub, { title: 'Clawd Mifflin', body: 'Alerts are on: you will hear from Claude here.', tag: 'welcome' }, JSON.parse(env.VAPID_JWK), PUSH_SUBJECT).catch(() => 0);
        return reply(null, 204);
      }
      if (route === '/push/send' && mac) {
        const message = { title: String(j.title || 'Clawd Mifflin').slice(0, 80), body: String(j.body || '').slice(0, 240), tag: String(j.tag || 'claude').slice(0, 64) };
        return reply(JSON.stringify({ sent: await alertAll(office, env, message) }), 200, { 'content-type': 'application/json' });
      }
      return reply('not found', 404);
    }
    if (route !== '/state') return reply('not found', 404);

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
