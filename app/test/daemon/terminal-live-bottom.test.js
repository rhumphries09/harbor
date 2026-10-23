'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A >_ PEEK MUST NOT LEAVE A FULLSCREEN CLAUDE SCROLLED AWAY (2026-10-22).
//
// Claude Code's fullscreen renderer owns its scroll position. A wheel in the
// >_ view scrolls the CLI itself, the CLI stops following new output, and it
// stays that way after the view closes: a session's terminal sat on its last
// typed prompt for an hour while the conversation view moved on, and every
// later >_ peek opened onto that stale screen. The daemon's model and the view
// both agreed with the CLI; the CLI was not at its bottom.
//
// This drives the REAL terminal bridge and stream supervisor against a REAL
// isolated sessiond, with a stand-in that keeps the CLI's measured scroll
// contract (test/support/fullscreen-claude-standin.js): open the view, scroll
// up inside it, close it, let the session produce output on its own, open the
// view again. The view and the session's own screen must show the newest
// output. Two-sided ON PURPOSE: the same peek on a pane recorded as codex
// (never sent the key) must stay scrolled, so the claude spec cannot pass
// because the stand-in never scrolled.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');
const { ScreenModel } = require('../../src/daemon/screen.js');
const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const STANDIN = path.join(__dirname, '../support/fullscreen-claude-standin.js');
const COLS = 80;
const ROWS = 12;
const WHEEL_UP = '\x1b[<64;5;5M';
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function waitUntil(probe, describe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(await describe());
    await sleep(50);
  }
}

async function startDaemon() {
  const store = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-live-bottom-'));
  const socketPath = path.join(store, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-live-bottom-${process.pid}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  // Registered BEFORE the readiness wait: a leaked daemon keeps node --test alive.
  cleanups.push(async () => {
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
      await sleep(1500);
    } catch { /* the daemon is already gone */ }
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((resolve) => daemon.once('exit', resolve)); }
    try { fs.rmSync(store, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
  });
  await waitUntil(async () => {
    try {
      const probe = new SessionClient({ socketPath });
      const result = await probe.request('health');
      probe.close();
      return result.ok;
    } catch { return false; }
  }, () => `daemon never answered: ${stderr}`, 10_000);
  return { store, socketPath, client };
}

// A stand-in pane recorded under `agent`. Its cwd is the temp root, never the
// store: a ConPTY child holds its cwd, and the store is deleted at teardown.
async function startPane(client, agent) {
  const env = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const spawned = await client.request('spawn', {
    argv: [process.execPath, STANDIN, '40'], cwd: realTmpDir(), env, cols: COLS, rows: ROWS, agent,
  });
  await waitUntil(async () => /standin live 40/.test((await client.request('screen', { id: spawned.id })).visible),
    async () => `the stand-in never drew:\n${(await client.request('screen', { id: spawned.id })).visible}`);
  return spawned.id;
}

// What XtermPane shows: a fresh terminal fed the bridge's backfill, then its
// frames, rebuilt on a reset, exactly as the renderer writes them.
function viewOf(bridge, paneId) {
  let screen = new ScreenModel({ cols: COLS, rows: ROWS });
  const onReset = ({ paneId: id }) => { if (id === paneId) screen = new ScreenModel({ cols: COLS, rows: ROWS }); };
  const onBackfill = ({ paneId: id, text }) => { if (id === paneId && text) screen.write(text); };
  const onFrame = ({ paneId: id, data }) => { if (id === paneId && data) screen.write(Buffer.from(data, 'base64').toString('utf8')); };
  bridge.emitter.on('reset', onReset);
  bridge.emitter.on('backfill', onBackfill);
  bridge.emitter.on('frame', onFrame);
  return {
    text: async () => (await screen.read()).visible,
    stop: () => {
      bridge.emitter.off('reset', onReset);
      bridge.emitter.off('backfill', onBackfill);
      bridge.emitter.off('frame', onFrame);
    },
  };
}

async function startBridge({ store, socketPath }) {
  const bridge = createTerminalBridge({
    sessionSocketPath: socketPath,
    sessionStorePolicy: { allowed: true },
    env: { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath },
  });
  bridge.emitter.on('error', () => {});
  cleanups.push(async () => bridge.close());
  await bridge.start();
  return bridge;
}

// The peek: open the >_ view, take control as a click into it does, scroll up
// twice inside it, close it. Then the session works on by itself.
async function peekThenWorkOn(bridge, client, paneId) {
  const sessionScreen = async () => (await client.request('screen', { id: paneId })).visible;
  await bridge.setVisiblePanes([{ paneId, cols: COLS, rows: ROWS }]);
  await bridge.focusPane({ paneId, cols: COLS, rows: ROWS });
  assert.deepEqual(bridge.sendInput(paneId, WHEEL_UP), { ok: true });
  assert.deepEqual(bridge.sendInput(paneId, WHEEL_UP), { ok: true });
  await waitUntil(async () => /standin scrolled 40/.test(await sessionScreen()),
    async () => `the wheel inside the view never scrolled the session:\n${await sessionScreen()}`);
  bridge.blurPane(paneId);
  await bridge.setVisiblePanes([]);
  // Output the CLI renders without a typed prompt (a running turn, a
  // background task's report): the real CLI does not re-follow for it.
  await client.request('input', { id: paneId, text: '+5\r' });
  await waitUntil(async () => / 45\s*$/.test((await sessionScreen()).trimEnd()),
    async () => `the session never produced its new output:\n${await sessionScreen()}`);
  return sessionScreen;
}

test('a >_ peek leaves a fullscreen claude following its output, and the next peek opens on it', { timeout: 120_000 }, async () => {
  const daemon = await startDaemon();
  const paneId = await startPane(daemon.client, 'claude');
  const bridge = await startBridge(daemon);

  const sessionScreen = await peekThenWorkOn(bridge, daemon.client, paneId);
  // The session's own screen is what every Harbor pane reader sees (the
  // window's live work meter among them), whether or not a view is open.
  const afterClose = await sessionScreen();
  assert.match(afterClose, /standin live 45/,
    `closing the view left the session's screen parked where the peek scrolled it:\n${afterClose}`);

  const view = viewOf(bridge, paneId);
  await bridge.setVisiblePanes([{ paneId, cols: COLS, rows: ROWS }]);
  let shown = '';
  try {
    await waitUntil(async () => {
      shown = await view.text();
      return /message 45/.test(shown) && /standin live 45/.test(shown);
    }, async () => `the >_ view reopened on the screen an earlier peek left behind, not the live output:\n${shown}`, 8000);
  } finally {
    view.stop();
  }
});

test('control: the same peek on a codex pane is never sent the key, and stays where it was scrolled', { timeout: 120_000 }, async () => {
  const daemon = await startDaemon();
  const paneId = await startPane(daemon.client, 'codex');
  const bridge = await startBridge(daemon);

  const sessionScreen = await peekThenWorkOn(bridge, daemon.client, paneId);
  await bridge.setVisiblePanes([{ paneId, cols: COLS, rows: ROWS }]);
  await sleep(1500);
  const screen = await sessionScreen();
  assert.match(screen, /standin scrolled 45/, `a codex pane must be left exactly as its user scrolled it:\n${screen}`);
  assert.doesNotMatch(screen, /message 45/, 'the newest output is below the scrolled view');
});
