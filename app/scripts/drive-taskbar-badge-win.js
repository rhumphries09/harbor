'use strict';

// Drive the taskbar badge end to end and record what actually reaches the
// window (2026-10-04, Pat: "i dont get the blue / yellow alert numbers
// anymore").
//
// The badge has three stages, and a missing badge can die in any of them: the
// renderer must decide to send a plan, main must accept it, and main must call
// setOverlayIcon. This drive boots the real App offscreen (isolated userData,
// no daemon, HARBOR_E2E), attaches to BOTH processes over CDP (the page for
// state, main's Node inspector for the IPC and the overlay call), and records
// every taskbar-badge:set and every setOverlayIcon while it walks a session
// through blocked -> clear -> blocked under transcript churn. No window is
// ever shown or focused.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PAGE_PORT = 9345;
const MAIN_PORT = 9346;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function target(port, pick, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const found = targets.find(pick);
      if (found) return found;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error(`no CDP target on ${port}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }

  static async open(url) {
    const ws = new globalThis.WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // cli: main's Node inspector only has require() through the command line API.
  async evaluate(expression, { awaitPromise = false, cli = false } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, includeCommandLineAPI: cli });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
    return result.result.value;
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

// Main process: record every badge IPC and every overlay call, in order.
const MAIN_PROBE = `
(() => {
  const { ipcMain, BrowserWindow } = require('electron');
  const log = globalThis.__badgeLog = [];
  ipcMain.on('taskbar-badge:set', (_event, payload) => {
    log.push({ t: Date.now(), stage: 'ipc', image: Boolean(payload && payload.dataUrl), d: payload && payload.description });
  });
  for (const win of BrowserWindow.getAllWindows()) {
    const original = win.setOverlayIcon.bind(win);
    win.setOverlayIcon = (image, description) => {
      log.push({ t: Date.now(), stage: 'overlay', image: Boolean(image), d: description });
      return original(image, description);
    };
  }
  return BrowserWindow.getAllWindows().length;
})()
`;

// Main process: a TERMINAL dialog, the evidence production actually has
// (2026-10-14: a guard permission prompt sat 24 minutes under a blue badge).
// Scenarios 1-3 raise the question through a transcript-header flag that the
// real transcript reader never sets, which is how they passed while the real
// app could not go amber for a prompt drawn in the terminal. Here the menu
// poll is answered by the REAL session-send getMenu reading a stand-in pane
// (the harness has no daemon) that draws the measured guard-prompt layout
// when __dialogUp is set and an idle composer otherwise. Every poll is
// recorded, so the raw-terminal case can prove it polled with `observe`.
const dialogProbe = (tmp) => `
(() => {
  const { ipcMain } = require('electron');
  const { createSessionSend, createLinkRegistry } = require(${JSON.stringify(path.join(APP_DIR, 'src', 'main', 'session-send.js'))});
  const { fixture } = require(${JSON.stringify(path.join(APP_DIR, 'test', 'support', 'permission-dialog-fixtures.js'))});
  const composer = ['─'.repeat(60), '❯ ', '─'.repeat(60), '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\\n');
  globalThis.__dialogUp = false;
  const calls = globalThis.__menuCalls = [];
  const keys = globalThis.__dialogKeys = [];
  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: 'pane-sess-a', workspace_id: 'ws-sess-a' }], workspaces: [{ workspace_id: 'ws-sess-a', label: 'badge-proj' }] }),
    readPane: async () => (globalThis.__dialogUp ? fixture('guard') : composer),
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'pane-sess-a' }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_paneId, text) => { keys.push(text); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd: 'C:/dev/badge-proj' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'badge-proj',
    sleep: async () => {},
    setXClipboardImage: async () => {},
    captureDir: ${JSON.stringify(path.join(tmp, 'unrecognized-dialogs'))},
    sendLogFile: ${JSON.stringify(path.join(tmp, 'send-log.jsonl'))},
  });
  ipcMain.removeHandler('session:menu-state');
  ipcMain.handle('session:menu-state', async (_event, payload) => {
    calls.push({ t: Date.now(), sessionId: payload && payload.sessionId, observe: Boolean(payload && payload.observe) });
    if (!payload || payload.sessionId !== 'sess-a') return null;
    return send.getMenu(payload);
  });
  return true;
})()
`;

// Page: a two-session model, both live and open as windows.
const PAGE_DRIVER = `
(() => {
  const now = Date.now();
  const row = (id, status) => ({
    id, project: 'badge-proj', title: 'Badge ' + id, firstPrompt: 'probe',
    lastActive: new Date(now).toISOString(), lastActiveMs: now,
    home: 'personal', provider: 'claude', model: null,
    isLive: true, paneId: 'pane-' + id, workspaceId: 'ws-' + id, agentStatus: status,
    isWindowsEra: true, isChildTask: false, childTitle: null, cwd: 'C:/dev/badge-proj', isHistorical: true,
  });
  const model = (statusA) => JSON.parse(JSON.stringify({
    projects: [{
      label: 'badge-proj', sessions: [row('sess-a', statusA), row('sess-b', 'working')], sessionCount: 2,
      lastActiveMs: now, hasLive: true, isWindowsEra: true, isOrchestration: false,
      isDateGroup: false, displayDayMs: null, newSessionCwd: 'C:/dev/badge-proj',
    }],
    liveProjects: ['badge-proj'], grouping: 'project',
  }));
  let seq = 0;
  const transcript = (blocked) => {
    seq += 1;
    return { blocks: [{ key: 'b' + seq, kind: 'assistant', text: 'prose ' + seq }], header: { model: 'claude-opus-5-5', blocked } };
  };
  window.__badgeDrive = {
    setup() {
      window.__setSidebarModelForTest(model('idle'));
      return true;
    },
    open() {
      window.__harborOpenSession('sess-a');
      window.__harborOpenSession('sess-b');
      return true;
    },
    // sess-a's question state, through the open transcript's header (the path an open window uses).
    blockA(blocked) {
      window.__setTranscriptForTest('sess-a', transcript(blocked));
      return true;
    },
    // Live churn on the OTHER window, the way a working session streams.
    async churnB(ms, everyMs) {
      const end = Date.now() + ms;
      let n = 0;
      while (Date.now() < end) {
        window.__setTranscriptForTest('sess-b', transcript(false));
        n += 1;
        await new Promise((r) => setTimeout(r, everyMs));
      }
      return n;
    },
    attention() { return window.__harborAttention; },
    // Flip sess-a's window to its raw terminal (>_), the way a click does.
    rawTerminal() {
      const tile = document.querySelector('[data-session-id="sess-a"]');
      const button = tile && tile.querySelector('button[title^="Raw terminal"]');
      if (!button) return false;
      button.click();
      return true;
    },
    // The answer card in sess-a's window, if one is drawn (a question card is
    // .ask, a permission card .permission-prompt).
    cardShown() {
      const tile = document.querySelector('[data-session-id="sess-a"]');
      return Boolean(tile && tile.querySelector('.ask, .permission-prompt'));
    },
  };
  return 'installed';
})()
`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-badge-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  // An EMPTY transcripts folder: the drive fabricates its own rail, and the
  // window waits on the history scan, which in this empty cache would read the
  // whole real corpus cold (over four minutes on 2026-10-14, heavy disk and
  // CPU work on a machine whose live daemon was already struggling).
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  // And an empty HOME: under HARBOR_E2E the codex, cursor and delegation scans
  // run with no cache by design, and against the real stores they no longer
  // finished before the window was due (the window waits on them).
  // Electron resolves appData from these, and fails to start without them.
  const home = path.join(tmp, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  for (const dir of [appData, localAppData]) fs.mkdirSync(dir, { recursive: true });
  // Codex profiles name their real stores outright, so they go too.
  config.profiles = (config.profiles || []).filter((profile) => (profile.provider || 'claude') === 'claude');
  config.paths = {
    ...config.paths,
    projectsDir: path.join(tmp, 'projects'),
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
    boardsDir: path.join(tmp, 'boards'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
    if (!condition) failures.push(message);
  };

  let child = null;
  let page = null;
  let main = null;
  try {
    child = spawn(ELECTRON, [
      `--inspect=${MAIN_PORT}`, APP_DIR, `--remote-debugging-port=${PAGE_PORT}`, '--no-focus-steal',
      // The E2E window is offscreen; without these Chromium throttles hidden-page
      // timers to one per second, which would starve the badge's 250ms coalescing
      // timer for a reason the visible app does not have.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ], {
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        HARBOR_E2E: '1',
        HARBOR_E2E_USER_DATA: userData,
        HARBOR_NO_DAEMON_START: '1',
        HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
        HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
        HARBOR_NO_ICON_GEN: '1',
        HARBOR_NO_USAGE_FETCH: '1',
        HARBOR_NO_TITLER: '1',
        HARBOR_NO_VOICE: '1',
      },
      // HARBOR_DRIVE_VERBOSE=1 shows the app's own output when the launch itself fails.
      stdio: process.env.HARBOR_DRIVE_VERBOSE === '1' ? 'inherit' : 'ignore',
    });

    const pageTarget = await target(PAGE_PORT, (t) => t.type === 'page' && !t.url.startsWith('devtools:'), 60000);
    page = await Cdp.open(pageTarget.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    let ready = false;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !ready) {
      await sleep(500);
      ready = await page.evaluate('typeof window.__setSidebarModelForTest === "function" && typeof window.__harborOpenSession === "function"').catch(() => false);
    }
    check(ready, 'App mounted with the HARBOR_E2E test hooks');
    if (!ready) throw new Error('renderer never exposed the test hooks');

    const mainTarget = await target(MAIN_PORT, () => true);
    main = await Cdp.open(mainTarget.webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    const windows = await main.evaluate(MAIN_PROBE, { cli: true });
    check(windows >= 1, `main probe installed on ${windows} window(s)`);

    check((await page.evaluate(PAGE_DRIVER)) === 'installed', 'page driver installed');
    await page.evaluate('window.__badgeDrive.setup()');
    await sleep(500);
    await page.evaluate('window.__badgeDrive.open()');
    await sleep(1500);

    const logSince = async (t0) => (await main.evaluate('globalThis.__badgeLog')).filter((e) => e.t >= t0);

    // 1. A quiet question: nothing else is moving.
    let t0 = Date.now();
    await page.evaluate('window.__badgeDrive.blockA(true)');
    await sleep(1500);
    let log = await logSince(t0);
    console.log('  quiet blocked:', JSON.stringify(log));
    check(log.some((e) => e.stage === 'ipc' && e.image), 'quiet question: renderer sends an amber badge');
    check(log.some((e) => e.stage === 'overlay' && e.image), 'quiet question: main sets the overlay');

    // 2. Answered: the amber goes. sess-a moved on after the watermark, so it now
    // reads as finished and the badge turns blue rather than clearing.
    t0 = Date.now();
    await page.evaluate('window.__badgeDrive.blockA(false)');
    await sleep(1500);
    log = await logSince(t0);
    console.log('  answered:', JSON.stringify(log));
    check(log.some((e) => e.stage === 'overlay' && String(e.d).startsWith('0 sessions waiting')), 'answered: main replaces the amber overlay');

    // 3. A question while another window streams (a transcript update every 100ms for 4s).
    t0 = Date.now();
    await page.evaluate('window.__badgeDrive.blockA(true)');
    const pushes = await page.evaluate('window.__badgeDrive.churnB(4000, 100)', { awaitPromise: true });
    log = await logSince(t0);
    console.log(`  blocked under churn (${pushes} pushes):`, JSON.stringify(log));
    check(log.some((e) => e.stage === 'ipc' && e.image), 'question under churn: renderer sends the amber badge while the other window streams');
    check(log.some((e) => e.stage === 'overlay' && e.image), 'question under churn: main sets the overlay while the other window streams');
    console.log('  attention:', JSON.stringify(await page.evaluate('window.__badgeDrive.attention()')));

    // 4. A guard permission prompt drawn in the terminal, with NO header flag
    // and no hook-lane ask: the mahjong case. Clear scenario 3 first.
    check(await main.evaluate(dialogProbe(tmp), { cli: true }), 'terminal-dialog stand-in installed in main');
    await page.evaluate('window.__badgeDrive.blockA(false)');
    await sleep(1500);
    t0 = Date.now();
    await main.evaluate('globalThis.__dialogUp = true');
    await sleep(2500);
    log = await logSince(t0);
    console.log('  terminal prompt:', JSON.stringify(log));
    check(await page.evaluate('window.__badgeDrive.cardShown()'), 'terminal prompt: the window draws its answer card');
    check(log.some((e) => e.stage === 'overlay' && e.image && String(e.d).startsWith('1 session waiting')), 'terminal prompt: main sets the AMBER overlay');

    t0 = Date.now();
    await main.evaluate('globalThis.__dialogUp = false');
    await sleep(2500);
    log = await logSince(t0);
    console.log('  terminal prompt answered:', JSON.stringify(log));
    check(log.some((e) => e.stage === 'overlay' && String(e.d).startsWith('0 sessions waiting')), 'terminal prompt answered: the amber overlay goes');

    // 5. The same prompt while the window shows its raw terminal (>_).
    check(await page.evaluate('window.__badgeDrive.rawTerminal()'), 'sess-a flipped to its raw terminal');
    await sleep(1500);
    t0 = Date.now();
    await main.evaluate('globalThis.__dialogUp = true');
    await sleep(2500);
    log = await logSince(t0);
    const calls = (await main.evaluate('globalThis.__menuCalls')).filter((c) => c.t >= t0 && c.sessionId === 'sess-a');
    console.log(`  raw-terminal prompt (${calls.length} polls, observe on ${calls.filter((c) => c.observe).length}):`, JSON.stringify(log));
    check(calls.length > 0 && calls.every((c) => c.observe), 'raw terminal: the window still polls, and only as an observer');
    check(!(await page.evaluate('window.__badgeDrive.cardShown()')), 'raw terminal: no card is drawn over the terminal');
    check(log.some((e) => e.stage === 'overlay' && e.image && String(e.d).startsWith('1 session waiting')), 'raw terminal: main sets the AMBER overlay');
    check((await main.evaluate('globalThis.__dialogKeys')).length === 0, 'no key was ever sent to the stand-in terminal');
    await main.evaluate('globalThis.__dialogUp = false');
  } finally {
    // The app exits mid-call and never answers, so do not wait on the reply.
    try { page?.send('Runtime.evaluate', { expression: 'window.harbor.e2e && window.harbor.e2e.quit()' }).catch(() => {}); } catch { /* exiting */ }
    page?.close();
    main?.close();
    await sleep(800);
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* gone */ } }
    // Verbose runs keep the isolated app's files (its lifecycle log is under cache/perf).
    if (process.env.HARBOR_DRIVE_VERBOSE === '1') console.log(`kept ${tmp}`);
    else try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
