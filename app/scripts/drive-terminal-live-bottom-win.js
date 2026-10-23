#!/usr/bin/env node
'use strict';

// LIVE PROOF that a >_ peek no longer leaves a fullscreen Claude Code parked
// on an old screen, against the REAL CLI in an ISOLATED daemon (relocated
// store, its own cwd, never the user's daemon), through the REAL terminal
// bridge and stream supervisor.
//
// Live-caught 2026-10-22: a session's >_ view showed the screen from the
// moment its last prompt was sent (that prompt, an empty composer, a current
// statusline) while the conversation view showed the long answer that had
// followed. The daemon's modeled screen agreed with the CLI: the CLI's own
// fullscreen view had stopped following its output after a wheel in a
// three-second >_ peek, and nothing re-follows until a typed prompt lands.
// The bridge now sends the CLI's "Jump to bottom" key (ctrl+End) when a
// claude pane's view opens and when it closes (terminal-bridge.js
// LIVE_BOTTOM_KEY).
//
// The drive: a session with more output than fits, then a slow bash-mode
// command (typed, so the CLI follows it as it lands). While it runs: open the
// >_ view, take control, wheel up twice inside it, close the view. The
// command's output lands with the view closed. PROOF OK only when the
// session's own screen shows that output's last line and no "(ctrl+End)"
// pill, and the reopened view does too. At the pre-fix HEAD the same drive
// ends on the stale screen (run it from a worktree, or point
// HARBOR_DRIVE_BRIDGE_MODULE at another checkout's src/main/terminal-bridge.js).
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-terminal-live-bottom-win.js
// Needs a signed-in claude; costs two tiny haiku turns. The probe session's
// transcript is deleted afterwards so it never reaches the rail.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { ScreenModel } = require('../src/daemon/screen.js');
const { claudeProjectDir } = require('../src/main/session-send.js');

const BRIDGE_MODULE = process.env.HARBOR_DRIVE_BRIDGE_MODULE
  ? path.resolve(process.env.HARBOR_DRIVE_BRIDGE_MODULE)
  : path.join(__dirname, '../src/main/terminal-bridge.js');
const { createTerminalBridge } = require(BRIDGE_MODULE);

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-live-bottom-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-live-bottom-cwd-'));
const socketPath = path.join(store, 'daemon.sock');
const COLS = 120;
const ROWS = 40;
const MARKER = `LIVEBOTTOM${process.pid}`;

const cleanup = { client: null, daemon: null, paneId: null, bridge: null, transcriptDir: null };
async function teardown() {
  const { client, daemon, paneId, bridge, transcriptDir } = cleanup;
  try { bridge?.close(); } catch { /* closing */ }
  if (client && paneId) { try { await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ } }
  await sleep(1500);
  if (client) client.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(5000)]);
  }
  await sleep(500);
  for (const dir of [store, cwd, transcriptDir].filter(Boolean)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
  }
}

async function main() {
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-live-bottom-proof-${process.pid}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.daemon = daemon;
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { const probe = new SessionClient({ socketPath }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }
  const client = new SessionClient({ socketPath, requestTimeoutMs: 30_000 });
  cleanup.client = client;
  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData', 'CLAUDE_CONFIG_DIR']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const claudeSession = randomUUID();
  // The fullscreen renderer is pinned here, so the drive does not depend on
  // this machine's own "tui" setting.
  const spawned = await client.request('spawn', {
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--dangerously-skip-permissions', '--settings', '{"tui":"fullscreen"}'],
    cwd, env: childEnv, cols: COLS, rows: ROWS,
  });
  const paneId = spawned.id;
  cleanup.paneId = paneId;
  cleanup.transcriptDir = path.dirname(path.join(claudeProjectDir(cwd), `${claudeSession}.jsonl`));
  console.log(`spawned pane ${paneId}, claude session ${claudeSession}, bridge ${BRIDGE_MODULE}`);

  const screen = async () => (await client.request('screen', { id: paneId })).visible;
  const until = async (probe, ms, what) => {
    const t = Date.now() + ms;
    while (Date.now() < t) { const v = await probe(); if (v) return v; await sleep(300); }
    throw new Error(`${what}\n--- screen ---\n${await screen()}`);
  };
  const settle = async (ms) => {
    let prev = null; let since = Date.now(); const t = Date.now() + ms;
    while (Date.now() < t) {
      const v = await screen();
      if (v !== prev) { prev = v; since = Date.now(); } else if (Date.now() - since > 3000 && !/esc to interrupt/i.test(v)) return v;
      await sleep(250);
    }
    return prev;
  };
  const type = async (text) => {
    await client.request('input', { id: paneId, text });
    await sleep(800);
    await client.request('input', { id: paneId, text: '\r' });
  };

  await until(async () => { const s = await screen(); return /❯/u.test(s) && !/Loading/u.test(s); }, 60_000, 'composer never came up');
  await sleep(1500);
  await type('Print Line 1 to Line 90, one per line, nothing else.');
  await settle(90_000);

  const bridge = createTerminalBridge({
    sessionSocketPath: socketPath,
    sessionStorePolicy: { allowed: true },
    env: { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath },
  });
  bridge.emitter.on('error', () => {});
  cleanup.bridge = bridge;
  await bridge.start();

  // A slow bash-mode command, typed so the CLI follows it as it lands.
  await client.request('input', { id: paneId, text: '!' });
  await sleep(500);
  await type(`sleep 10; seq 1 30; echo ${MARKER}`);
  await sleep(2500);

  // The peek, while it runs: open, take control, wheel up twice, close.
  await bridge.setVisiblePanes([{ paneId, cols: COLS, rows: ROWS }]);
  await bridge.focusPane({ paneId, cols: COLS, rows: ROWS });
  await sleep(600);
  bridge.sendInput(paneId, '\x1b[<64;40;12M');
  await sleep(80);
  bridge.sendInput(paneId, '\x1b[<64;40;12M');
  await until(async () => /\(ctrl\+End\)/.test(await screen()), 10_000, 'the wheel inside the view never scrolled the CLI');
  console.log('peek scrolled the CLI (its pill is showing)');
  await sleep(1500);
  bridge.blurPane(paneId);
  await bridge.setVisiblePanes([]);

  // The command's output lands with the view closed.
  const transcript = path.join(claudeProjectDir(cwd), `${claudeSession}.jsonl`);
  const landedBy = Date.now() + 30_000;
  await until(async () => (fs.existsSync(transcript) && fs.readFileSync(transcript, 'utf8').includes(MARKER)) || Date.now() > landedBy,
    40_000, 'the bash output never landed');
  await settle(60_000);
  const closedScreen = await screen();
  const closedLive = closedScreen.includes(MARKER) && !/\(ctrl\+End\)/.test(closedScreen);
  console.log(`--- the session's own screen after the peek closed ---\n${closedScreen}`);

  // Reopen the view exactly as XtermPane is fed: backfill, then frames.
  let view = new ScreenModel({ cols: COLS, rows: ROWS });
  bridge.emitter.on('reset', () => { view = new ScreenModel({ cols: COLS, rows: ROWS }); });
  bridge.emitter.on('backfill', ({ paneId: id, text }) => { if (id === paneId && text) view.write(text); });
  bridge.emitter.on('frame', ({ paneId: id, data }) => { if (id === paneId && data) view.write(Buffer.from(data, 'base64').toString('utf8')); });
  await bridge.setVisiblePanes([{ paneId, cols: COLS, rows: ROWS }]);
  await sleep(2500);
  const viewText = (await view.read()).visible;
  const viewLive = viewText.includes(MARKER) && !/\(ctrl\+End\)/.test(viewText);
  console.log(`--- the reopened >_ view ---\n${viewText}`);

  if (closedLive && viewLive) {
    console.log('PROOF OK: the peek left the CLI following its output, and the reopened view shows it');
  } else {
    console.log(`PROOF FAILED: session screen ${closedLive ? 'live' : 'STALE'}, reopened view ${viewLive ? 'live' : 'STALE'}`);
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error('DRIVE FAILED', error); process.exitCode = 1; }).finally(teardown);
