'use strict';

// A Cursor API-key sign-in has to be resupplied on every run: cursor-agent DELETES
// auth.json when it holds an apiKey and a run passes none (2026-10-13, measured on
// a copy). These pin the helper every Harbor cursor child goes through.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cursorAuthFile, cursorAuthEnv } = require('../../src/shared/cursor-auth.cjs');
const { sessiondChildEnv } = require('../../../bin/harbor-bin.cjs');

function home(t, auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (auth !== undefined) {
    const file = cursorAuthFile(dir, {}, 'win32');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof auth === 'string' ? auth : JSON.stringify(auth));
  }
  return dir;
}

test('cursor-auth finds auth.json where cursor-agent keeps it on each platform', () => {
  assert.equal(cursorAuthFile('/h', { APPDATA: 'C:\\R' }, 'win32'), path.join('C:\\R', 'Cursor', 'auth.json'));
  assert.equal(cursorAuthFile('/h', {}, 'win32'), path.join('/h', 'AppData', 'Roaming', 'Cursor', 'auth.json'));
  assert.equal(cursorAuthFile('/h', {}, 'darwin'), path.join('/h', '.cursor', 'auth.json'));
  assert.equal(cursorAuthFile('/h', { XDG_CONFIG_HOME: '/x' }, 'linux'), path.join('/x', 'cursor', 'auth.json'));
});

test('cursor-auth hands a stored API key to the child, and only then', (t) => {
  const keyed = home(t, { accessToken: 'a', refreshToken: 'r', apiKey: 'synthetic-key' });
  const env = { PATH: 'p' };
  const out = cursorAuthEnv(env, { home: keyed, platform: 'win32' });
  assert.deepEqual(out, { PATH: 'p', CURSOR_API_KEY: 'synthetic-key' });
  assert.equal(env.CURSOR_API_KEY, undefined, 'the caller env is never mutated');
  // An empty CURSOR_API_KEY is "none" to cursor-agent, so it is filled too.
  assert.equal(cursorAuthEnv({ CURSOR_API_KEY: '' }, { home: keyed, platform: 'win32' }).CURSOR_API_KEY, 'synthetic-key');
  // A key the caller already supplies wins.
  const own = { CURSOR_API_KEY: 'caller-key' };
  assert.equal(cursorAuthEnv(own, { home: keyed, platform: 'win32' }), own);
  // A browser sign-in, no sign-in, and an unreadable file all leave env alone.
  for (const auth of [{ accessToken: 'a', refreshToken: 'r' }, undefined, 'not json']) {
    const dir = home(t, auth);
    assert.equal(cursorAuthEnv(env, { home: dir, platform: 'win32' }), env);
  }
});

test('sessiond forwards CURSOR_API_KEY to a cursor pane and to nothing else', () => {
  const source = { CURSOR_API_KEY: 'synthetic-key', CLAUDE_CONFIG_DIR: '/x/.claude' };
  assert.equal(sessiondChildEnv(source, { agent: 'cursor' }).CURSOR_API_KEY, 'synthetic-key');
  for (const agent of ['claude', 'codex', null]) {
    assert.equal(sessiondChildEnv(source, { agent }).CURSOR_API_KEY, undefined, `${agent} must not carry the key`);
  }
  assert.equal(sessiondChildEnv(source).CURSOR_API_KEY, undefined);
});
