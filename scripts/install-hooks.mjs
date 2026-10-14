#!/usr/bin/env node
// Add Claude Code hooks that tell the office server about each event straight away (instead of it noticing a
// few seconds later in the transcript), including permission prompts the transcript never shows.
// The hooks run in the background (async) and give up after 2 s, so Claude never waits on the office.
//   node scripts/install-hooks.mjs            add them to ~/.claude/settings.json (a backup is kept next to it)
//   node scripts/install-hooks.mjs --remove   take them out again
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const MARK = 'clawd-mifflin';
const COMMAND = `curl -s -m 2 -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4717/api/hook || true # ${MARK}`;
const EVENTS = { PreToolUse: '*', PostToolUse: '*', Notification: null, Stop: null, UserPromptSubmit: null, PostCompact: null };

const text = fs.readFileSync(FILE, 'utf8');
const settings = JSON.parse(text);
const hooks = (settings.hooks ||= {});
for (const event of Object.keys(hooks)) {
  hooks[event] = hooks[event].filter((g) => !g.hooks?.some((h) => String(h.command || '').includes(MARK)));
  if (!hooks[event].length) delete hooks[event];
}
const remove = process.argv.includes('--remove');
if (!remove) {
  for (const [event, matcher] of Object.entries(EVENTS)) {
    (hooks[event] ||= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: COMMAND, async: true }] });
  }
}
if (!Object.keys(hooks).length) delete settings.hooks;
fs.writeFileSync(`${FILE}.bak-${MARK}`, text);
fs.writeFileSync(FILE, `${JSON.stringify(settings, null, 2)}\n`);
console.log(remove ? `removed the office hooks from ${FILE}` : `added office hooks for ${Object.keys(EVENTS).join(', ')} to ${FILE}`);
