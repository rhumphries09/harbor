'use strict';

// Load an ISOLATED session daemon the way a busy evening loads the real one,
// and measure whether it keeps up (2026-10-14: the live daemon was killed as
// wedged twice in twelve minutes while about fourteen sessions worked at once,
// and each fresh replacement lagged within seconds).
//
// Nothing here touches the real store: the daemon runs on a temp store and
// socket, watches this script's pid (harness-watch.js) and dies with it.
// Sessions are a stand-in TUI that repaints a screen at a fixed frame rate,
// so output volume is a dial rather than a guess. The client side mirrors what
// Harbor asks the daemon for: `list` polls (one per SessionSubscription, every
// second), a `screen` read per open window every 700 ms (the answer card) and
// every second while it works (the work meter), and `observe` streams (the >_
// view) with an optional duplicate count, because Harbor's detach never told
// the daemon to stop (streams.js detach).
//
// Usage: node scripts/load-sessiond-win.js [--sessions 14] [--fps 20]
//   [--rows 60] [--cols 120] [--observe 0] [--dup 1] [--seconds 40]
//   [--no-polls] [--slow-reader] [--profile <dir>]
// Prints health-request latency, the daemon's own lag lines, its CPU and RSS.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionClient } = require('../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(ROOT, 'src', 'daemon', 'daemon.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}
const opts = {
  sessions: Number(arg('sessions', 14)),
  fps: Number(arg('fps', 20)),
  rows: Number(arg('rows', 60)),
  cols: Number(arg('cols', 120)),
  observe: Number(arg('observe', 0)),
  dup: Number(arg('dup', 1)),
  seconds: Number(arg('seconds', 40)),
  polls: !process.argv.includes('--no-polls'),
  slowReader: process.argv.includes('--slow-reader'),
  profile: arg('profile', null),
};

// The stand-in TUI: home the cursor and repaint every row, coloured, with a
// moving spinner, the way an Ink renderer repaints its live region.
const SIM = `
const rows = Number(process.argv[2]); const cols = Number(process.argv[3]); const fps = Number(process.argv[4]);
const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'; let n = 0;
const word = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ';
setInterval(() => {
  n += 1;
  let out = '\\x1b[H';
  for (let r = 0; r < rows - 1; r += 1) {
    const text = (spin[(n + r) % spin.length] + ' ' + word.repeat(3)).slice((n + r) % 40).slice(0, cols - 2);
    out += '\\x1b[38;5;' + ((n + r) % 230 + 16) + 'm' + text + '\\x1b[0m\\x1b[K\\r\\n';
  }
  out += '\\x1b[2m' + n + ' frames\\x1b[0m\\x1b[K';
  process.stdout.write(out);
}, Math.max(1, Math.round(1000 / fps)));
`;

function cpuSeconds(pid) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], { encoding: 'utf8', windowsHide: true });
    return Number(String(out).trim());
  } catch { return NaN; }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sessiond-load-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const simPath = path.join(dir, 'sim.js');
  fs.writeFileSync(simPath, SIM);
  const profileArgs = opts.profile ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(String(opts.profile))}`] : [];
  const daemon = spawn(guiNodeExec, [...profileArgs, DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_LAG_LOG_MS: '200',
      HARBOR_SESSIOND_RSS_INTERVAL_MS: '5000',
      HARBOR_NO_DAEMON_START: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });

  const control = new SessionClient({ socketPath });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await control.request('health')).ok) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(100);
  }

  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  // The stand-in must be a CONSOLE program: Electron is GUI-subsystem, gets no
  // console under ConPTY, and its writes reach no pane at all. This script runs
  // under the system node, whose binary is the console one.
  const ids = [];
  for (let i = 0; i < opts.sessions; i += 1) {
    const spawned = await control.request('spawn', {
      argv: [process.execPath, simPath, String(opts.rows), String(opts.cols), String(opts.fps)],
      cwd: dir, env: childEnv, cols: opts.cols, rows: opts.rows,
    });
    ids.push(spawned.id);
  }
  await sleep(2000);

  // Observe streams, through one long-lived client the way the supervisor does.
  const streams = new SessionClient({ socketPath });
  let frames = 0;
  let frameBytes = 0;
  let degraded = 0;
  let droppedFrames = 0;
  streams.onEvent((event) => {
    if (event.type === 'stream-degraded') { degraded += 1; droppedFrames += event.dropped_frames || 0; return; }
    if (event.type !== 'frame') return;
    frames += 1;
    frameBytes += (event.bytes || event.text || '').length;
  });
  if (opts.slowReader) {
    // A reader that falls behind: pause the socket for 2 s in every 3.
    await streams.connect();
    setInterval(() => { streams.socket?.pause(); setTimeout(() => streams.socket?.resume(), 2000); }, 3000).unref();
  }
  for (const id of ids.slice(0, opts.observe)) {
    for (let d = 0; d < opts.dup; d += 1) await streams.request('observe', { id });
  }

  // Harbor's polls.
  const timers = [];
  const errors = { poll: 0 };
  if (opts.polls) {
    const poller = new SessionClient({ socketPath });
    const safe = (p) => p.catch(() => { errors.poll += 1; });
    for (let s = 0; s < 4; s += 1) timers.push(setInterval(() => safe(poller.request('list')), 1000));
    for (const id of ids) {
      timers.push(setInterval(() => safe(poller.request('screen', { id, scrollback: 90 })), 700));
      timers.push(setInterval(() => safe(poller.request('screen', { id, scrollback: 0 })), 1000));
    }
  }

  // The watchdog's question, timed: a real health request on a fresh connection.
  const latencies = [];
  const cpu0 = cpuSeconds(daemon.pid);
  const t0 = Date.now();
  while (Date.now() - t0 < opts.seconds * 1000) {
    const probe = new SessionClient({ socketPath, requestTimeoutMs: 20000 });
    const started = Date.now();
    try { await probe.request('health'); latencies.push(Date.now() - started); }
    catch { latencies.push(20000); }
    probe.close();
    await sleep(1000);
  }
  const elapsed = (Date.now() - t0) / 1000;
  const cpu1 = cpuSeconds(daemon.pid);
  for (const timer of timers) clearInterval(timer);

  const log = fs.readFileSync(path.join(dir, 'sessiond.log'), 'utf8');
  const lags = [...log.matchAll(/event loop lag observed: (\d+)ms/g)].map((m) => Number(m[1]));
  const rss = [...log.matchAll(/rss pid=\d+ rss_bytes=(\d+) heap_used_bytes=(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  console.log(JSON.stringify({
    opts: { ...opts, profile: Boolean(opts.profile) },
    daemonCpuPctOfOneCore: Math.round(((cpu1 - cpu0) / elapsed) * 1000) / 10,
    healthMs: { p50: pct(0.5), p95: pct(0.95), max: latencies.at(-1) },
    lagLines: lags.length,
    lagMaxMs: lags.length ? Math.max(...lags) : 0,
    rssMaxMB: rss.length ? Math.round(Math.max(...rss.map((r) => r[0])) / 1048576) : null,
    heapMaxMB: rss.length ? Math.round(Math.max(...rss.map((r) => r[1])) / 1048576) : null,
    observedFramesPerSec: Math.round(frames / elapsed),
    observedMBPerSec: Math.round((frameBytes / elapsed / 1048576) * 100) / 100,
    degradedNotices: degraded,
    droppedFrames,
    pollErrors: errors.poll,
  }));

  // Clean shutdown so a --cpu-prof profile is written.
  for (const id of ids) await control.request('terminate', { id, signal: 'SIGKILL' }).catch(() => {});
  await control.request('shutdown').catch(() => {});
  await new Promise((resolve) => { if (daemon.exitCode !== null) resolve(); else daemon.once('exit', resolve); setTimeout(resolve, 10000); });
  control.close();
  streams.close();
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(2); });
