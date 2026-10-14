import test from 'node:test';
import assert from 'node:assert/strict';
import { charFor, activity } from '../server.mjs';

const ids = new Set(['playwright', 'context7', 'caveman', 'engineering', 'security-audit']);

test('tool calls map to the right character', () => {
  assert.equal(charFor('mcp__plugin_playwright_playwright__browser_click', {}, ids), 'playwright');
  assert.equal(charFor('mcp__plugin_engineering_github__authenticate', {}, ids), 'engineering');
  assert.equal(charFor('mcp__claude_ai_Google_Drive__search_files', {}, ids), 'google-drive');
  assert.equal(charFor('mcp__claude-in-chrome__navigate', {}, ids), 'claude-in-chrome');
  assert.equal(charFor('Skill', { skill: 'caveman:caveman-commit' }, ids), 'caveman');
  assert.equal(charFor('Skill', { skill: 'security-audit' }, ids), 'security-audit');
  assert.equal(charFor('Agent', { subagent_type: 'Explore' }, ids), 'agent');
  assert.equal(charFor('Write', { file_path: '/x/.claude/projects/p/memory/a.md' }, ids), 'memory');
  assert.equal(charFor('Grep', {}, ids), 'reader');
  assert.equal(charFor('Bash', {}, ids), 'bash');
});

test('pending calls work, finished calls linger then stop', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const use = (id, name, s) => ({ type: 'assistant', sessionId: 'a', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const result = (id, s) => ({ type: 'user', sessionId: 'a', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  const records = [
    use('1', 'mcp__plugin_playwright_playwright__browser_click', 10),          // still running
    use('2', 'Bash', 60), result('2', 59),                                     // finished long ago
    use('3', 'Read', 5), result('3', 2),                                       // finished, lingering
  ];
  const { status } = activity([{ records, mtime: now - 1000 }], ids, now);
  assert.equal(status.playwright?.working, true);
  assert.equal(status.bash, undefined);
  assert.equal(status.reader?.working, true);
  assert.equal(status.claude?.working, true);
  const { counts } = activity([{ records, mtime: now - 1000 }], ids, now);
  assert.deepEqual(counts, { playwright: 1, bash: 1, reader: 1 });
  // Interrupted session: no result and file untouched for 10 minutes.
  const stale = activity([{ records: [use('4', 'Bash', 700)], mtime: now - 600000 }], ids, now);
  assert.equal(stale.status.bash, undefined);
});

import { wlFeature, isoWeek, scorePlugins } from '../server.mjs';

// a made-up HQ: the real one lives in private/hq.json, outside git
const HQ = { root: 'acme', features: [{ id: 'hq-shop', paths: ['src/shop', 'src/cart/'] }, { id: 'hq-site', paths: ['website/'] }] };

test('HQ file paths map to their feature office', () => {
  const root = '/Users/x/Project_Pipeline/acme/';
  assert.equal(wlFeature(`${root}src/shop-page.tsx`, HQ.features, HQ.root), 'hq-shop');
  assert.equal(wlFeature(`${root}website/index.html`, HQ.features, HQ.root), 'hq-site');
  assert.equal(wlFeature(`${root}src/cart/total.ts`, HQ.features, HQ.root), 'hq-shop');
  assert.equal(wlFeature('/Users/x/other/src/shop-page.tsx', HQ.features, HQ.root), null);
});

test('subagents, failures and sessions come out of the transcript', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const records = [
    { type: 'assistant', sessionId: 's1', cwd: '/p/my-app', timestamp: at(5), message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { subagent_type: 'Explore', description: 'find auth' } }] } },
    { type: 'assistant', sessionId: 's1', timestamp: at(9), message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } },
    { type: 'user', sessionId: 's1', timestamp: at(8), message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true }] } },
  ];
  const r = activity([{ records, mtime: now - 1000 }], ids, now);
  assert.equal(r.subagents[0]?.type, 'Explore');
  assert.equal(r.failures[0]?.char, 'bash');
  assert.equal(r.sessions[0]?.project, 'my-app');
  assert.equal(r.sessions[0]?.busy, true);
});

test('weekly picks skip installed plugins and rotate by week', () => {
  const list = ['alpha', 'beta', 'gamma'].map((name) => ({ name, marketplace: 'm', category: 'development', text: `${name} supabase database` }));
  const kw = new Map([['supabase', 400]]);
  const picks = scorePlugins(list, kw, '2026-W42', new Set(['alpha']), 5, 5);
  assert.deepEqual(picks.map((p) => p.name).sort(), ['beta', 'gamma']);
  assert.match(picks[0].install, /^\/plugin install (beta|gamma)@m$/);
  assert.equal(isoWeek(Date.parse('2026-10-13T12:00:00Z')), '2026-W42');
});

import { dundies, hookEvent } from '../server.mjs';

test('waiting, context and compaction per session; replay keeps today in order', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 249000 };
  const records = [
    { type: 'system', subtype: 'compact_boundary', sessionId: 'w', timestamp: at(300), compactMetadata: { preTokens: 560000 } },
    { type: 'assistant', sessionId: 'w', cwd: '/p/x', timestamp: at(60), message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }], usage, stop_reason: 'tool_use' } },
    { type: 'user', sessionId: 'w', timestamp: at(59), message: { content: [{ type: 'tool_result', tool_use_id: 'r', is_error: true }] } },
    { type: 'assistant', sessionId: 'w', timestamp: at(50), message: { content: [{ type: 'text', text: 'done' }], usage, stop_reason: 'end_turn' } },
    { type: 'assistant', sessionId: 'b', timestamp: at(5), message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }], usage: { input_tokens: 50000 }, stop_reason: 'tool_use' } },
  ];
  const r = activity([{ records, mtime: now - 1000 }], ids, now);
  const w = r.sessions.find((s) => s.id === 'w'), b = r.sessions.find((s) => s.id === 'b');
  assert.equal(w.waiting, 'reply');
  assert.equal(w.busy, false);
  assert.deepEqual(w.ctx, { tokens: 250002, max: 1000000, compactedAt: now - 300000 });
  assert.equal(b.waiting, null);
  assert.equal(b.busy, true);
  assert.equal(b.ctx.max, 200000);
  assert.deepEqual(r.replay.map(([t, who, , err]) => [now - t, who, err]), [[60000, 'reader', 1], [5000, 'bash', 0]]);
});

test('dundies pick the busiest, the clumsiest, the night owl and the longest nap', () => {
  const day = Date.parse('2026-10-12T16:00:00Z'); // midnight MYT
  const h = (x) => day + x * 3600e3;
  const replay = [[h(1), 'bash', 'x', 0], [h(9), 'bash', 'x', 1], [h(10), 'bash', 'x', 0], [h(11), 'reader', 'x', 1], [h(11.5), 'reader', 'x', 1], [h(12), 'claude', 'x', 0]];
  assert.deepEqual(dundies(replay).map((a) => [a.award, a.char]), [['Most Tool Calls', 'bash'], ['Butterfingers', 'reader'], ['Night Owl', 'bash'], ['Longest Nap', 'bash']]);
  assert.deepEqual(dundies([]), []);
});

test('hooks mark a session waiting and clear it when work resumes', () => {
  assert.equal(hookEvent({ session_id: 's', hook_event_name: 'Notification', notification_type: 'permission_prompt' }).waiting, 'permission');
  assert.equal(hookEvent({ session_id: 's', hook_event_name: 'PostToolUse' }).waiting, null);
  assert.equal(hookEvent({ session_id: 's', hook_event_name: 'Stop' }).waiting, 'reply');
  assert.equal(hookEvent({ hook_event_name: 'Stop' }), undefined);
});

import { sourceUrl, repoCandidate, isMcpRepo } from '../server.mjs';

test('every plugin, MCP server and repo gets a page to get it from', () => {
  const repo = 'https://github.com/anthropics/claude-plugins-official';
  assert.equal(sourceUrl('./plugins/clangd-lsp', repo), `${repo}/tree/main/plugins/clangd-lsp`);
  assert.equal(sourceUrl('./', 'https://github.com/x/caveman'), 'https://github.com/x/caveman');
  assert.equal(sourceUrl({ source: 'github', repo: 'a/b' }), 'https://github.com/a/b');
  assert.equal(sourceUrl({ source: 'url', url: 'https://github.com/getsentry/plugin-claude.git' }), 'https://github.com/getsentry/plugin-claude');
  assert.equal(sourceUrl({ source: 'git-subdir', url: 'https://github.com/stripe/ai.git', path: 'providers/claude/plugin', ref: 'main' }), 'https://github.com/stripe/ai/tree/main/providers/claude/plugin');
  const r = { full_name: 'o/ntfy-mcp', name: 'ntfy-mcp', description: 'push', stargazers_count: 9, owner: { login: 'o' }, html_url: 'https://github.com/o/ntfy-mcp', clone_url: 'https://github.com/o/ntfy-mcp.git', homepage: 'https://www.npmjs.com/package/ntfy-mcp' };
  assert.equal(isMcpRepo(r), true);
  assert.equal(isMcpRepo({ name: 'photo-scanner', topics: [] }), false);
  const c = repoCandidate(r, 'push', true);
  assert.equal(c.url, 'https://github.com/o/ntfy-mcp');
  assert.equal(c.install, 'claude mcp add ntfy-mcp -- npx -y ntfy-mcp');
  assert.equal(repoCandidate(r, 'push').install, 'git clone https://github.com/o/ntfy-mcp.git');
});

import { pluginProsCons, repoProsCons, heatFrom, resultText, roundRobin } from '../server.mjs';

test('suggestions come with pros and cons', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const big = { name: 'revit-mcp', description: 'AI-Powered Revit Modeling', stargazers_count: 4720, pushed_at: '2026-10-10T00:00:00Z', license: { spdx_id: 'MIT' }, owner: { type: 'Organization', login: 'mcp-servers-for-revit' } };
  const r1 = repoProsCons(big, now);
  assert.ok(r1.pros.some((p) => p.includes('4.7k stars')));
  assert.ok(r1.pros.some((p) => p.includes('MIT')));
  assert.ok(r1.cons.some((c) => c.includes('Windows')));
  const small = { name: 'x', description: '这是', stargazers_count: 12, pushed_at: '2024-01-01T00:00:00Z', license: null, owner: { type: 'User' } };
  const r2 = repoProsCons(small, now);
  assert.ok(r2.cons.length === 3 && r2.cons[0].includes('12 stars'));
  const p = pluginProsCons({ author: 'Sentry', url: 'https://sentry.io', description: 'Sentry MCP server. Needs a Sentry account.', why: ['sentry'] });
  assert.ok(p.pros.includes('official plugin from Sentry'));
  assert.ok(p.cons.some((c) => c.includes('MCP')) && p.cons.some((c) => c.includes('account')));
  assert.ok(pluginProsCons({ author: 'Anthropic', description: 'x' }).pros.includes('made by Anthropic'));
});

test('heat, failure text and the weekly shuffle', () => {
  assert.deepEqual(heatFrom('10\t2\tsrc/shop-page.tsx\n-\t-\tassets/x.png\n5\t5\twebsite/index.html\n1\t0\tREADME.md', HQ.features, HQ.root), { 'hq-shop': 12, 'hq-site': 10 });
  assert.equal(resultText([{ type: 'text', text: '<tool_use_error>Exit code 1</tool_use_error>' }]), 'Exit code 1');
  assert.equal(resultText('boom'), 'boom');
  const lists = [[{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], [{ name: 'x' }]];
  const out = roundRobin(lists, '2026-W42', 6);
  assert.equal(out.length, 4); // the best three of the first list, plus the one in the second
  assert.ok(out.some((p) => p.name === 'x'));
});

test('payroll counts each API message once and badges come from the transcript', () => {
  const now = Date.parse('2026-10-14T04:00:00Z');
  const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 };
  const msg = (uuid) => ({ type: 'assistant', uuid, sessionId: 's', cwd: '/p/proj', timestamp: new Date(now - 5000).toISOString(), effort: 'high', message: { id: 'm1', model: 'claude-opus-5-5', usage, content: [] } });
  const records = [msg('a'), msg('b'), { type: 'permission-mode', permissionMode: 'plan', sessionId: 's' }];
  const r = activity([{ records, mtime: now }], ids, now);
  assert.deepEqual(r.payroll[0], { id: 's', project: 'proj', input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 });
  assert.equal(r.sessions[0].model, 'claude-opus-5-5');
  assert.equal(r.sessions[0].effort, 'high');
  assert.equal(r.sessions[0].mode, 'plan');
});

import { publicState, seal } from '../server.mjs';

test('the public demo carries nothing private', () => {
  const s = {
    hq: { name: 'Secret', future: [{ id: 'hq-ads' }], hr: [{ id: 'hqhr-tools' }] },
    characters: [{ id: 'memory', memory: [{ project: 'Project-Pipeline-secret', files: ['a', 'b'] }] }, { id: 'bash' }],
    hr: { week: 'W', picks: [{ name: 'p' }], rooms: { 'hq-ads': [1], 'hqhr-tools': [2], 'fair-bim': [3] }, features: { 'hq-shop': [4] } },
    deliveries: [1], builds: [1], heat: { x: 1 }, report: {}, dundies: {}, music: {}, wlLinks: {}, events: [1], sessions: [1], payroll: [1], replay: [1],
  };
  const out = publicState(s);
  const text = JSON.stringify(out);
  assert.ok(!/secret/i.test(text));
  assert.deepEqual(Object.keys(out.hr.rooms), ['fair-bim']);
  assert.equal(out.hr.features, undefined);
  assert.deepEqual(out.characters[0].memory, [{ project: 'project 1', files: ['memory', 'memory'] }]);
  for (const k of ['hq', 'deliveries', 'builds', 'heat', 'report', 'wlLinks']) assert.equal(out[k], undefined);
});

test('the sealed demo opens only with its password', async () => {
  const box = await seal({ hello: 'world' }, 'pw', 1000);
  const raw = (b) => Uint8Array.from(Buffer.from(b, 'base64'));
  const open = async (password) => {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: raw(box.salt), iterations: box.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw(box.iv) }, key, raw(box.data))));
  };
  assert.deepEqual(await open('pw'), { hello: 'world' });
  await assert.rejects(open('nope'));
});

import { clashes, digestText } from '../server.mjs';

test('two sessions editing one file is a clash; one session is not', () => {
  const now = Date.parse('2026-10-14T01:00:00Z');
  const edit = (sid, s, file = '/p/app/src/index.ts') => ({ name: 'Edit', input: { file_path: file }, sid, ts: now - s * 1000 });
  const c = clashes([edit('a', 300), edit('b', 30), edit('a', 20, '/p/app/README.md')], now);
  assert.equal(c.length, 1);
  assert.equal(c[0].file, 'src/index.ts');
  assert.deepEqual(c[0].sessions.sort(), ['a', 'b']);
  assert.equal(clashes([edit('a', 300), edit('a', 30)], now).length, 0);
  assert.equal(clashes([edit('a', 900), edit('b', 200)], now).length, 0); // the latest edit is over 2 minutes old
});

test('the daily digest reads like a summary', () => {
  const t = digestText({
    now: Date.parse('2026-10-14T12:00:00Z'), counts: { bash: 30, reader: 10 }, replay: [[1, 'bash', 'x', 1]],
    payroll: [{ input: 10, cacheWrite: 90, cacheRead: 1900, output: 0 }], characters: [{ id: 'bash', name: 'Bash' }],
    usage: { session: { pct: 33 }, weekly: { pct: 50 } }, builds: [{ name: 'Deploy', conclusion: 'failure' }],
  }, null);
  assert.match(t, /40 tool calls, 1 failed, 1 sessions, 2k tokens/);
  assert.match(t, /Busiest: Bash 30/);
  assert.match(t, /weekly 50%/);
  assert.match(t, /Red builds: Deploy/);
});

import { pkceChallenge, playerInfo } from '../server.mjs';

test('Spotify: the PKCE challenge and the player answer', () => {
  // RFC 7636, appendix B
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const m = playerInfo({
    is_playing: true, progress_ms: 61000, device: { name: 'iPhone' },
    item: { name: 'Song', duration_ms: 200000, artists: [{ name: 'A' }, { name: 'B' }], album: { name: 'LP', images: [{ url: 'https://i/640', width: 640 }, { url: 'https://i/300', width: 300 }] }, external_urls: { spotify: 'https://open.spotify.com/track/x' } },
  });
  assert.equal(m.artist, 'A, B');
  assert.equal(m.art, 'https://i/300');
  assert.equal(m.device, 'iPhone');
  assert.equal(m.playing, true);
  assert.deepEqual(playerInfo(null), { connected: true, running: false, playing: false });
});

import { encryptPayload, vapidHeader, vapidPublic, validSubscription, b64u } from '../worker/push.js';

test('web push: the browser can decrypt what the relay encrypts (RFC 8291), and the VAPID token verifies', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPayload('{"title":"hi"}', b64u.enc(uaPublic), b64u.enc(auth));
  // decrypt the way a browser does
  const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), cipher = body.slice(21 + idlen);
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const ikm = await hk(auth, shared, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), '{"title":"hi"}');
  assert.equal(plain.at(-1), 2);
  // VAPID: the JWT verifies with the public key it carries
  const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', vk.privateKey);
  const h = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', jwk, 'https://example.com/');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, vapidPublic(jwk));
  const [hd, pl, sig] = jwt.split('.');
  assert.equal(JSON.parse(new TextDecoder().decode(b64u.dec(pl))).aud, 'https://fcm.googleapis.com');
  const pub = await crypto.subtle.importKey('raw', b64u.dec(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64u.dec(sig), te.encode(`${hd}.${pl}`)));
  // only real push services
  const keys = { p256dh: b64u.enc(uaPublic), auth: b64u.enc(auth) };
  assert.ok(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }));
  assert.ok(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys }));
  assert.ok(!validSubscription({ endpoint: 'https://evil.example/x', keys }));
  assert.ok(!validSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys }));
});

import { costOf, addToLedger, alertFor } from '../server.mjs';

test('cost at API prices: cache writes by TTL, cheap cache reads, fast mode, long Haiku prompts', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  // Opus 5.5: $4 in, $5 5m write, $8 1h write, $0.20 read, $20 out per million
  near(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 1e6 } }), 4 + 20 + 0.2 + 5 + 8);
  near(costOf('claude-sonnet-5-5', { input_tokens: 1e6 }), 2);
  near(costOf('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
  near(costOf('claude-haiku-5-5', { input_tokens: 50000 }), 0.005);
  near(costOf('claude-haiku-5-5', { input_tokens: 150000 }), 0.075); // over 100k: the higher price for the whole request
  near(costOf('claude-opus-5-5', { input_tokens: 1e6, inference_geo: 'us' }), 4.4);
  assert.equal(costOf('<synthetic>', { input_tokens: 1e6 }), 0);
  // the ledger counts each API message once even when it spans several records
  const L = { seen: new Set(), days: {} };
  const line = JSON.stringify({ type: 'assistant', sessionId: 's', cwd: '/p/app', timestamp: '2026-10-14T02:00:00Z', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1e6 } } });
  addToLedger(L, line); addToLedger(L, line);
  near(L.days['2026-10-14'].s.cost, 2);
  assert.equal(L.days['2026-10-14'].s.input, 1e6);
});

test('phone alerts: permission at once, a finished turn only after a long one', () => {
  const j = { session_id: 's', cwd: '/p/app', hook_event_name: 'Stop', last_assistant_message: 'All  done.\nTests pass.' };
  const now = 1e9;
  assert.equal(alertFor(j, null, 'reply', now - 20e3, now), null);
  assert.deepEqual(alertFor(j, null, 'reply', now - 120e3, now), { title: 'Claude · app is done', body: 'Finished after 2 min: All done. Tests pass.', tag: 's:reply' });
  assert.equal(alertFor({ ...j, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }, null, 'permission', 0, now).body, 'Claude needs your permission to use Bash');
  assert.equal(alertFor(j, 'reply', 'reply', 0, now), null); // no change, no alert
});
