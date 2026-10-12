'use strict';

const { spawn, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9340;
const OUT = path.join(os.tmpdir(), 'harbor-drive-orch');
const RUN_LINE = '1 working · 1 awaiting review · 1 quiet · 1 ready, not started · 1 waiting on other batches';
const SESSION_ID ='a1000000-0000-4000-8000-000000000001';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'page evaluation failed');
    return response.result.value;
  }
  async shot(name) {
    const response = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(response.data, 'base64'));
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  if (!process.env.DRIVE_SKIP_BUILD) execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-orch-drive-'));
  const userData = path.join(tmp, 'userData');
  const projectsDir = path.join(tmp, 'projects');
  const delegateDir = path.join(tmp, 'delegate');
  const workspace = fs.realpathSync(path.resolve(APP_DIR, '..'));
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(delegateDir, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(delegateDir, 'events'), { recursive: true });
  const transcriptDir = path.join(projectsDir, 'drive-project');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(transcriptDir, `${SESSION_ID}.jsonl`), [
    { type: 'user', sessionId: SESSION_ID, cwd: workspace, timestamp: new Date(now - 60_000).toISOString(), message: { role: 'user', content: 'Drive orchestration status' } },
    { type: 'assistant', sessionId: SESSION_ID, cwd: workspace, timestamp: new Date(now - 50_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');

  const queue = {
    queue_id: 'drive-orch-run', workspace, goal: 'Prove every active batch wears the age of its evidence',
    created_at: new Date(now - 60 * 60_000).toISOString(), updated_at: new Date(now - 2 * 60_000).toISOString(),
    batches: [
      { id: 'working', title: 'Working batch', status: 'active', worker_engine: 'codex', last_dispatched_at: new Date(now - 15 * 60_000).toISOString() },
      { id: 'review', title: 'Finished unreviewed batch', status: 'active', worker_engine: 'claude', last_dispatched_at: new Date(now - 30 * 60_000).toISOString() },
      { id: 'quiet', title: 'Quiet batch', status: 'active', worker_engine: 'cursor', last_dispatched_at: new Date(now - 55 * 60_000).toISOString() },
      // 2026-10-12: a pending batch says whether it could start now or what
      // holds it, and two finished ones give the dependency-aware ETA.
      { id: 'ready', title: 'Ready batch nobody dispatched', status: 'pending', worker_engine: 'claude' },
      { id: 'held', title: 'Held batch', status: 'pending', worker_engine: 'claude', depends_on: ['working', 'review', 'quiet'] },
      { id: 'early-1', title: 'Finished batch one', status: 'done', worker_engine: 'claude', started_at: new Date(now - 60 * 60_000).toISOString(), completed_at: new Date(now - 40 * 60_000).toISOString() },
      { id: 'early-2', title: 'Finished batch two', status: 'done', worker_engine: 'codex', started_at: new Date(now - 60 * 60_000).toISOString(), completed_at: new Date(now - 30 * 60_000).toISOString() },
      // A failed batch, for the red Error group.
      { id: 'broken', title: 'Failed batch', status: 'failed', worker_engine: 'codex', notes: 'review: tests deleted' },
    ],
  };
  const digest = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(delegateDir, 'queues', `${digest}.json`), JSON.stringify(queue, null, 2));
  fs.writeFileSync(path.join(delegateDir, 'events', 'drive-orch-run.jsonl'), [
    // Fresh, so a slow boot cannot age the working batch past the 3-minute
    // working window before the panel is read (it did on 2026-10-12).
    { t: new Date(now).toISOString(), msg: 'working active signal' },
    { t: new Date(now - 10 * 60_000).toISOString(), msg: 'review worker finished' },
    { t: new Date(now - 45 * 60_000).toISOString(), msg: 'quiet last worker signal' },
  ].map(JSON.stringify).join('\n') + '\n');

  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.orchestration = { ...config.orchestration, enabled: true };
  config.paths = { ...config.paths, projectsDir, delegateStateDir: delegateDir, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), projectIconsDir: path.join(tmp, 'icons') };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env: { ...process.env, HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'), HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_NO_ICON_GEN: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1' },
    // The app's own output lands beside the screenshots, so a launch that
    // never opens its debug port says why instead of timing out blind.
    stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.log'), 'a')],
  });
  const results = [];
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  try {
    let target;
    for (let index = 0; index < 180 && !target; index += 1) {
      await sleep(500);
      try { target = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json())).find((item) => item.type === 'page' && !item.url.startsWith('devtools:')); } catch {}
    }
    if (!target) throw new Error('CDP target never appeared');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    // Tabs are found by aria-label: inactive view tabs draw no text (views.md).
    await waitFor(cdp, "Boolean(document.querySelector('.view-switch-btn[aria-label=\"Orch\"]'))", 'Orch tab');
    await cdp.eval(`localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify({ tiles: [{ sessionId: SESSION_ID, slot: 0 }], selectedId: SESSION_ID }))}); localStorage.setItem('harbor-view', 'orch'); location.reload()`);
    await waitFor(cdp, "document.querySelectorAll('.orch-run-batch').length === 8", 'eight overview batches');
    // Grouped by status (Pat, 2026-10-12): running, error, not started, done,
    // each with its own static dot colour on the heading and on every row.
    const groups = await cdp.eval(`[...document.querySelectorAll('.orch-run-group')].map((group) => ({
      head: group.querySelector('.orch-run-group-head').textContent,
      rows: group.querySelectorAll('.orch-run-batch').length,
      dot: getComputedStyle(group.querySelector('.orch-run-group-head .orch-run-dot')).backgroundColor,
      rowDots: [...group.querySelectorAll('.orch-run-batch .orch-run-dot')].map((dot) => getComputedStyle(dot).backgroundColor),
      animated: [...group.querySelectorAll('.orch-run-dot')].some((dot) => getComputedStyle(dot).animationName !== 'none'),
    }))`);
    results.push(`groups: ${groups.map((group) => `${group.head} (${group.rows} rows, ${group.dot})`).join('; ')}`);
    check(JSON.stringify(groups.map((group) => [group.head, group.rows])) === JSON.stringify([['Running3', 3], ['Error1', 1], ['Not started2', 2], ['Done2', 2]]), 'groups are not Running 3, Error 1, Not started 2, Done 2 in that order');
    check(new Set(groups.map((group) => group.dot)).size === 4, 'the four groups do not have four different dot colours');
    check(groups.every((group) => group.rowDots.every((color) => color === group.dot)), 'a row dot does not match its group colour');
    check(groups.find((group) => group.head.startsWith('Done'))?.dot === 'rgb(126, 201, 122)', 'done is not green');
    check(groups.find((group) => group.head.startsWith('Error'))?.dot === 'rgb(255, 95, 95)', 'error is not red');
    check(groups.every((group) => !group.animated), 'a status dot is animated');
    const overview = await cdp.eval("[...document.querySelectorAll('.orch-run-batch')].map((row) => ({ text: row.textContent, quiet: row.classList.contains('quiet') }))");
    const text = overview.map((row) => row.text).join('\n');
    results.push(`overview: ${text}`);
    check(text.includes('working, last signal'), 'working state or signal age missing');
    check(text.includes('awaiting review, last signal'), 'awaiting review state or signal age missing');
    check(text.includes('quiet 45m, possibly hung'), 'quiet state missing');
    check(overview.some((row) => row.quiet), 'quiet batch is not amber');
    // The row's three spans concatenate with no separator in textContent.
    check(text.includes('Ready batch nobody dispatchedclaudeready, not started'), 'ready batch does not read "ready, not started"');
    check(text.includes('waits on working, review +1 more'), 'held batch does not name what it waits on');
    const runLine = await cdp.eval("[...document.querySelectorAll('.orch-run-eta')].map((node) => node.textContent).join(' | ')");
    results.push(`run line: ${runLine}`);
    // Counted by what each worker is doing, never "3 running" over a working,
    // a finished and a hung worker (review finding, 2026-10-12).
    check(runLine.includes(RUN_LINE), 'run counts line missing');
    check(/rough ETA about \d+ min, 2 batches are past the usual length so likely later/.test(runLine), 'dependency-aware ETA or its running-long note missing');
    await cdp.shot('1-live-runs-overview');

    await cdp.eval("document.querySelector('.view-switch-btn[aria-label=\"Agents\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.orch-pill'))", 'session orchestration pill');
    const pill = await cdp.eval("({ text: document.querySelector('.orch-pill').textContent, title: document.querySelector('.orch-pill').title, quiet: document.querySelector('.orch-pill').classList.contains('quiet') })");
    results.push(`pill: ${pill.text}`);
    check(/^Orch 2\/8/.test(pill.text), 'pill does not show Orch done/total');
    check(pill.text.includes('last signal'), 'pill omits signal age');
    check(pill.title.startsWith(pill.text), 'pill tooltip does not carry the whole clipped line');
    await cdp.shot('2-session-pill');
    await cdp.eval("document.querySelector('.orch-pill').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.orch-panel') && document.querySelectorAll('.orch-batch-card').length === 8)", 'focused run panel');
    const panel = await cdp.eval("({ eta: document.querySelector('.orch-eta')?.textContent || '', cards: [...document.querySelectorAll('.orch-batch-card')].map((card) => card.textContent) })");
    results.push(`panel summary: ${panel.eta}`);
    check(panel.eta.includes(RUN_LINE), 'panel summary omits the run counts');
    check(panel.eta.includes('past the usual length'), 'panel ETA omits the running-long note');
    check(panel.cards.some((card) => card.includes('ready, not started')), 'panel ready card missing');
    check(panel.cards.some((card) => card.includes('waits on working, review +1 more')), 'panel waiting card does not name its blockers');
    const stamps = await cdp.eval("[...document.querySelectorAll('.orch-event-row time')].map((node) => ({ text: node.textContent, height: node.getBoundingClientRect().height }))");
    results.push(`event stamps: ${stamps.map((stamp) => `${stamp.text} (${Math.round(stamp.height)}px)`).join(', ')}`);
    check(stamps.length && stamps.every((stamp) => /^\d\d:\d\d$/.test(stamp.text) && stamp.height < 24), 'event times are not one-line clock times');
    await cdp.shot('3-pill-focused-run');
    await cdp.eval("[...document.querySelectorAll('.orch-batch-card')].find((card) => card.textContent.includes('Held batch')).scrollIntoView({ block: 'center' })");
    await sleep(300);
    await cdp.shot('4-panel-waiting-card');
    // The fixture workspace is derived from wherever this repo checkout lives,
    // so the assertion must be too; a literal folder name pinned the drive to
    // the worktree it was authored in (caught on the first main-tree run).
    check(await cdp.eval(`document.querySelector('.orch-panel-title').textContent.includes(${JSON.stringify(path.basename(workspace))})`), 'pill did not focus the matching run');
  } finally {
    await sleep(500);
    try { child.kill(); } catch {}
  }
  const verdict = failures.length ? `FAIL\n${failures.join('\n')}` : 'PASS';
  const report = `${verdict}\n\n${results.join('\n')}\nscreenshots: ${OUT}\n`;
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), `FAIL\n${error.stack || error.message}\n`);
  console.error(error);
  process.exit(2);
});
