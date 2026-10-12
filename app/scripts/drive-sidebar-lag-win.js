'use strict';

// REAL App, preload and sidebar bridge; synthetic history and daemon only.
// HARBOR_LAG_APP selects a separately built baseline checkout. No live attach.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const APP = path.resolve(process.env.HARBOR_LAG_APP || path.join(__dirname, '..'));
const OUT = path.resolve(process.env.HARBOR_LAG_OUT || path.join(__dirname, '../../_astra/lag-drive'));
const PORT = Number(process.env.HARBOR_LAG_PORT || 9358);
const ROWS = Number(process.env.HARBOR_LAG_ROWS || 10000);
const DURATION = Number(process.env.HARBOR_LAG_DURATION || 22000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const now = Date.now();
  const sessions = Array.from({ length: ROWS }, (_, i) => ({
    id: `synthetic-session-${String(i).padStart(18, '0')}`,
    project: `Synthetic project ${i % 227}`,
    title: `Review synthetic release ${i}: verify the build and update the report`,
    firstPrompt: 'Check the sample implementation and report the evidence. '.repeat(4),
    cwd: `C:\\synthetic\\sample-project-${i % 227}`,
    lastActive: new Date(now - i * 20000).toISOString(),
    provider: i % 100 < 57 ? 'codex' : i % 100 < 99 ? 'claude' : 'cursor',
    entrypoint: i % 100 >= 57 && i % 2 === 0 ? 'sdk-cli' : 'cli',
    lineage: i % 100 < 57 ? { kind: i % 2 ? 'exec' : 'guardian', parentThreadId: i % 2 ? null : 'synthetic-parent-000000000000000000', startedMs: now - i * 20000, source: 'synthetic-load-test', originator: 'codex_exec', agentPath: '/root/sample-review' } : null,
    delegatedBy: i % 100 < 57 && i % 2 === 0 ? 'synthetic-parent-000000000000000000' : null,
  }));
  // Nine interactive panes plus one live machine run exercise the exception.
  for (let i = 1; i < 10; i++) Object.assign(sessions[i], { provider: 'claude', entrypoint: 'cli', lineage: null, delegatedBy: null });
  const workspaces = Array.from({ length: 10 }, (_, i) => ({ workspace_id: `w${i}`, label: sessions[i].project, cwd: sessions[i].cwd }));
  const panes = workspaces.map((w, i) => ({ pane_id: `p${i}`, workspace_id: w.workspace_id, agent: sessions[i].provider, agent_session: { kind: 'id', value: sessions[i].id }, agent_status: 'idle' }));
  return { sessions, workspaces, panes };
}

async function host() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', path.join(OUT, 'userData'));
  app.commandLine.appendSwitch('remote-debugging-port', String(PORT));
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  const data = fixture();
  const { createSidebarBridge } = require(path.join(APP, 'src/main/sidebar-bridge.js'));
  const history = Object.assign(new EventEmitter(), { listSessions: async () => data.sessions, sessionHomes: async () => ({}), close() {} });
  let helperInteractive = false; let daemonEvent;
  const bridge = createSidebarBridge({ history, providerHistory: null, providerSessionLinker: null, delegationIndex: null,
    createControlClient: () => ({
      processInfo: async () => ({ foreground_processes: [{ pid: 123, argv: ['codex.exe', ...(helperInteractive ? [] : ['exec']), 'resume', data.sessions[0].id] }] }),
      bootstrap: async (options) => { daemonEvent = options.onEvent; return { snapshot: data, subscription: Object.assign(new EventEmitter(), { close() {} }) }; },
    }) });
  bridge.emitter.on('error', (error) => console.error(error));
  await bridge.start();
  const { METHOD_CHANNELS } = require(path.join(APP, 'src/main/rpc/channels.js'));
  const { emptyDoc } = require(path.join(APP, 'src/shared/tasks-model.cjs'));
  let win; let chatter; let pushes = [];
  const answers = {
    'sidebar:get-state': () => bridge.getState(),
    'terminal:get-state': () => ({ panes: [], workspaces: [], tabs: [], connected: false }),
    'new-session:options': () => ({ profiles: [], providers: {}, defaults: {} }),
    'setup:state': () => ({ completed: true, orchestrationEnabled: true }),
    'tasks:read': () => emptyDoc(), 'ask:list': () => [], 'project-icons:list': () => [],
    'links:get': () => ({}), 'usage:get-all': () => ({}), 'orchestration:list-runs': () => [],
    'orchestration:list-delegations': () => [],
    'orchestration:list-sub-sessions': (request) => bridge.listSubSessions?.(request) || { groups: [], total: 0 },
    'orchestration:get-session': ({ id }) => bridge.getSession?.(id), 'session:send-queue': () => ({ queued: [] }),
    'session:workflow-runs': () => [], 'session:menu-state': () => null,
    'capabilities:get': () => ({ ok: true, capabilities: { commands: [], models: { cached: [] } } }),
    'transcript:open': ({ sessionId }) => {
      win.webContents.send('transcript:update', { sessionId, replace: [{ key: 'b0', kind: 'assistant', text: 'Synthetic conversation ready for typing.' }], header: { model: 'synthetic-model', working: false } });
      return { ok: true };
    },
  };
  for (const { method } of METHOD_CHANNELS) ipcMain.handle(method, (_event, payload) => (answers[method] || (() => null))(payload));
  bridge.emitter.on('update', (payload) => {
    const outgoing = payload.delta || payload;
    const bytes = Buffer.byteLength(JSON.stringify(outgoing));
    pushes.push({ at: Date.now(), bytes });
    win?.webContents.send('sidebar:update', outgoing);
  });
  // A harness-owned HTTP endpoint controls only this synthetic host.
  const server = require('node:http').createServer((req, res) => {
    if (req.url === '/identity') { res.end(JSON.stringify({ pid: process.pid, app: APP })); return; }
    if (req.url === '/resume-helper' || req.url === '/headless-helper') {
      helperInteractive = req.url === '/resume-helper';
      daemonEvent({ event: 'pane.updated', data: { pane: { pane_id: 'p0', agent: 'codex' } } });
    }
    if (req.url === '/start') {
      pushes = []; let n = 0;
      chatter = setInterval(() => {
        const i = n % 10; const status = Math.floor(n / 10) % 2 ? 'idle' : 'working'; n++;
        bridge.onPaneAgentStatus({ event: 'pane.agent_status_changed', data: { pane_id: `p${i}`, agent_status: status } });
      }, 1000);
    }
    if (req.url === '/stop') { clearInterval(chatter); chatter = null; }
    res.end(JSON.stringify({ pushes, railRows: bridge.getState().model.projects.reduce((n,p) => n + p.sessions.length, 0), fullBytes: Buffer.byteLength(JSON.stringify(bridge.getState())) }));
  });
  await new Promise((resolve) => server.listen(PORT + 1, '127.0.0.1', resolve));
  await app.whenReady();
  win = new BrowserWindow({ show: false, focusable: false, x: -10000, y: -10000, width: 2560, height: 1600,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: path.join(APP, 'src/preload/index.js') } });
  for (const method of ['show', 'showInactive', 'focus', 'maximize', 'moveTop', 'setAlwaysOnTop']) win[method] = () => { throw Error(`Forbidden window action: ${method}`); };
  await win.loadFile(path.join(APP, 'dist/index.html'));
  app.on('before-quit', () => { bridge.close(); clearInterval(chatter); server.close(); });
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.onmessage = ({ data }) => { const msg = JSON.parse(data); const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); };
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.seq; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}
async function drive() {
  fs.mkdirSync(path.join(OUT, 'userData'), { recursive: true });
  // Refuse occupied ports before spawning or connecting. Never discover a
  // target from another Electron instance sharing a debugging port.
  for (const port of [PORT, PORT + 1]) await new Promise((resolve, reject) => {
    const server = require('node:net').createServer();
    server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
  const env = { ...process.env, HARBOR_E2E: '1', HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(OUT, 'sessiond'),
    HARBOR_SESSIOND_SOCKET: `\\\\.\\pipe\\harbor-lag-drive-${process.pid}`, HARBOR_CONTEXT_DIR: path.join(OUT, 'context'), HARBOR_NO_MODEL_DISCOVERY: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(APP, 'node_modules/electron/dist/electron.exe'), [__filename, '--host', '--no-focus-steal'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
  let ws;
  try {
    let target;
    const expectedUrl = require('node:url').pathToFileURL(path.join(APP, 'dist/index.html')).href;
    for (let n = 0; n < 120 && !target; n++) {
      await sleep(250);
      if (child.exitCode != null) throw Error(`Harness exited: ${log}`);
      try {
        const owner = await fetch(`http://127.0.0.1:${PORT + 1}/identity`).then((r) => r.json());
        if (owner.pid !== child.pid || owner.app !== APP) throw Error('Foreign harness endpoint');
        target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((r) => r.type === 'page' && r.url === expectedUrl);
      } catch {}
    }
    if (!target) throw Error('No harness CDP target');
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws);
    for (let n = 0; n < 100; n++) { if (await cdp.eval('Boolean(window.__harborOpenSession)')) break; await sleep(100); }
    const ids = fixture().sessions.slice(0, 10).map((s) => s.id);
    await cdp.send('Page.enable');
    for (const id of ids) { await cdp.eval(`window.__harborOpenSession(${JSON.stringify(id)})`); await sleep(80); }
    await cdp.eval(`window.__harborOpenSession(${JSON.stringify(ids[1])})`);
    for (let n = 0; n < 120; n++) { if (await cdp.eval('document.querySelectorAll(".win2[data-session-id]").length === 10 && Boolean(document.querySelector("[contenteditable=true]"))')) break; await sleep(100); }
    await sleep(2000);
    const windows = await cdp.eval('document.querySelectorAll(".win2[data-session-id]").length');
    if (windows !== 10) {
      console.log(await cdp.eval('({text:document.body.innerText.slice(0,3000), stats:window.__harborSidebarStats, stage:localStorage.getItem("harbor-slate-stage")})'));
      throw Error(`Expected 10 windows, got ${windows}`);
    }
    await cdp.eval(`(() => {
      window.__lag = { blocks: [], latency: [], inputs: 0, frames: [] };
      const obs = new PerformanceObserver(list => { for (const e of list.getEntries()) window.__lag.blocks.push(e.duration); }); obs.observe({ entryTypes: ['longtask'] });
      const editor = document.querySelector('[contenteditable=true]'); editor.focus();
      editor.addEventListener('input', () => { const t = performance.now(); window.__lag.inputs++; requestAnimationFrame(() => window.__lag.latency.push(performance.now() - t)); });
      let last = performance.now(); function frame(t) { window.__lag.frames.push(t - last); last=t; window.__lag.raf=requestAnimationFrame(frame); } requestAnimationFrame(frame);
    })()`);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const before = await metrics(); const started = Date.now();
    await fetch(`http://127.0.0.1:${PORT + 1}/start`);
    while (Date.now() - started < DURATION) {
      await cdp.send('Input.insertText', { text: 'x' });
      await sleep(75);
    }
    const after = await metrics();
    const transport = await fetch(`http://127.0.0.1:${PORT + 1}/stop`).then((r) => r.json());
    const observed = await cdp.eval('cancelAnimationFrame(window.__lag.raf); window.__lag');
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'typing.png'), Buffer.from(screenshot.data, 'base64'));
    const sorted = observed.latency.sort((a, b) => a - b);
    const result = { app: APP, rows: ROWS, windows, seconds: (Date.now() - started) / 1000,
      railRows: transport.railRows, fullBytes: transport.fullBytes, pushes: transport.pushes.length,
      maxPushBytes: Math.max(0, ...transport.pushes.map((p) => p.bytes)),
      bytesPerSecond: transport.pushes.reduce((n, p) => n + p.bytes, 0) / ((Date.now() - started) / 1000),
      busyPercent: 100 * (after.TaskDuration - before.TaskDuration) / (after.Timestamp - before.Timestamp),
      longestTaskMs: Math.max(0, ...observed.blocks), longestFrameMs: Math.max(0, ...observed.frames),
      inputs: observed.inputs, inputLatencyMaxMs: Math.max(0, ...sorted), inputLatencyP95Ms: sorted[Math.floor(sorted.length * 0.95)] };
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.pushes || result.inputs < 50) throw Error('Drive did not exercise status pushes and typing');
    if (process.argv.includes('--assert-fixed') && (result.maxPushBytes >= 10000 || result.longestTaskMs >= 100)) throw Error('Fixed performance bound failed');
    if (process.argv.includes('--assert-fixed')) {
      const waitFor = async (expression) => {
        for (let i = 0; i < 100; i++) { if (await cdp.eval(expression)) return; await sleep(100); }
        throw Error(`UI did not settle: ${expression}`);
      };
      const shot = async (name) => {
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(capture.data, 'base64'));
      };
      await cdp.eval(`window.__harborOpenSession(${JSON.stringify(ids[0])})`);
      await waitFor('Boolean(document.querySelector(".win2.sel .ro-flag"))');
      await fetch(`http://127.0.0.1:${PORT + 1}/resume-helper`);
      await waitFor('!document.querySelector(".win2.sel .ro-flag") && Boolean(document.querySelector("[contenteditable=true]"))');
      await shot('resumed-helper');
      await fetch(`http://127.0.0.1:${PORT + 1}/headless-helper`);
      await waitFor('Boolean(document.querySelector(".win2.sel .ro-flag"))');
      await shot('headless-helper');
      await cdp.eval(`(async () => {
        const state = await window.harbor.sidebar.getState();
        const model = structuredClone(state.model); const row = model.projects.flatMap(p => p.sessions).find(s => s.id === ${JSON.stringify(ids[1])});
        row.title = 'Synthetic App pin'; window.__setSidebarModelForTest(model);
        const rail = structuredClone(state.model); rail.projects.flatMap(p => p.sessions).find(s => s.id === row.id).title = 'Synthetic rail pin';
        window.__setRailModelForTest(rail);
      })()`);
      await waitFor('document.querySelector(".rail")?.innerText.includes("Synthetic rail pin") && document.querySelector(".grid4")?.innerText.includes("Synthetic App pin")');
      await shot('independent-pins');
      await cdp.eval('window.__setSidebarModelForTest(null); window.__setRailModelForTest(null)');
      await cdp.eval('document.querySelector("[role=tab][aria-label=Orch]").click()');
      await waitFor('document.querySelectorAll(".sub-session-row").length === 100');
      await shot('orch-bounded');
      await cdp.eval('document.querySelector(".sub-session-search").focus()');
      await cdp.send('Input.insertText', { text: 'release 11:' });
      await waitFor('document.querySelectorAll(".sub-session-row").length === 1');
      await shot('orch-search');
      await cdp.eval('document.querySelector(".sub-sessions input[type=checkbox]").click()');
      await sleep(300); await shot('orch-older');
      const opened = await cdp.eval('document.querySelector(".sub-session-row").dataset.subSessionId');
      await cdp.eval('document.querySelector(".sub-session-row").click()');
      await waitFor(`Boolean(document.querySelector('.win2.sel[data-session-id="${opened}"]'))`);
      if (!(await cdp.eval('document.body.innerText.toLowerCase().includes("read-only")'))) throw Error('Sub-session is not read-only');
      await shot('sub-session-open');
      await cdp.send('Page.reload');
      await sleep(700);
      await waitFor(`Boolean(document.querySelector('.win2.sel[data-session-id="${opened}"]'))`);
      await shot('sub-session-reloaded');
      if (await cdp.eval(`Boolean(document.querySelector('.sr[data-session-id="${opened}"]'))`)) throw Error('Opened history sub-session leaked into the rail');
      fs.writeFileSync(path.join(OUT, 'ui-results.json'), JSON.stringify({ resumedHelperDrivable: true, headlessHelperReadOnly: true, independentPins: true, boundedRows: 100, searchMatches: 1, opened, restoredAfterReload: true, absentFromRail: true }, null, 2));
    }
  } finally {
    ws?.close(); child.kill();
    fs.writeFileSync(path.join(OUT, 'host.log'), log);
  }
}
if (process.argv.includes('--host')) host().catch((e) => { console.error(e); process.exit(1); });
else drive().catch((e) => { console.error(e); process.exitCode = 1; });
