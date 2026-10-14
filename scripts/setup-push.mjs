#!/usr/bin/env node
// Make the relay's VAPID key for phone alerts and store it as the VAPID_JWK secret. The private key is never
// printed or written to disk here; run again only to replace it (every phone then has to switch Alerts on again).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', keys.privateKey);
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker');
const r = spawnSync('npx', ['-y', 'wrangler@4', 'secret', 'put', 'VAPID_JWK'], { cwd: worker, input: JSON.stringify({ kty, crv, x, y, d }), stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(r.status ?? 1);
