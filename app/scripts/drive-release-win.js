'use strict';

// Smoke-test a PACKAGED Windows build before its release goes public
// (2026-10-12: the first release; an installer nobody has launched does not
// ship). Point it at the unpacked app folder (the one holding Harbor.exe):
//
//   node scripts/drive-release-win.js <folder with Harbor.exe>
//
// To get that folder from a release installer without installing anything
// (no shortcuts, no uninstall entry, nothing next to an existing Harbor):
//   7z x Harbor-Setup-<v>-x64.exe -o<tmp>\nsis
//   7z x <tmp>\nsis\$PLUGINSDIR\app-64.7z -o<tmp>\app
//
// It launches the packaged app fully isolated (its own userData, its own
// session daemon store and context dir, so nothing touches a Harbor already
// running here), with the window moved off-screen and --no-focus-steal, then
// checks that the renderer mounted, that the packaged session daemon started
// and connected (the part a packaging mistake breaks first: node-pty and the
// bin/ scripts live outside the asar), and that the main views render.
// Screenshots, the app's own log and a verdict land in %TEMP%\harbor-drive-release.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = path.resolve(process.argv[2] || '');
const EXE = path.join(APP, 'Harbor.exe');
const PORT = 9342;
const OUT = path.join(os.tmpdir(), 'harbor-drive-release');

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

async function waitFor(cdp, expression, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression).catch(() => false)) return true;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`no Harbor.exe in ${APP}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-release-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  // A minimal finished setup so the window opens on the app, not the wizard.
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    setup: { completed: true, completedAt: new Date().toISOString(), appVersion: 'release-drive' },
    paths: { projectsDir: path.join(tmp, 'projects'), cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), projectIconsDir: path.join(tmp, 'icons'), delegateStateDir: path.join(tmp, 'delegate') },
  }, null, 2));

  const log = fs.openSync(path.join(OUT, 'app.log'), 'w');
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env: {
      ...process.env,
      HARBOR_E2E: '1',
      HARBOR_E2E_USER_DATA: userData,
      HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
      HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
      HARBOR_NO_ICON_GEN: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_NO_TITLER: '1',
    },
    stdio: ['ignore', log, log],
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
    if (!target) throw new Error('the packaged app never opened its debug port');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // Off-screen, never activated (SWP_NOZORDER | SWP_NOACTIVATE).
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1440, 900, 0x0014) }"`, { stdio: 'ignore' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    await waitFor(cdp, "Boolean(document.querySelector('.view-switch'))", 'the renderer to mount');
    results.push(`url: ${target.url}`);
    check(target.url.startsWith('file:'), 'the packaged window did not load its bundled file:// renderer');
    // The daemon banner shows while the session daemon is unreachable; a
    // packaged build that cannot start sessiond keeps it up.
    let daemonUp = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const banner = await cdp.eval("[...document.querySelectorAll('div,span')].some((node) => /Terminal daemon unreachable/.test(node.textContent || '') && node.children.length === 0)");
      if (!banner) { daemonUp = true; break; }
      await sleep(2000);
    }
    const bannerText = await cdp.eval("([...document.querySelectorAll('div,span')].find((node) => /Terminal daemon unreachable/.test(node.textContent || '') && node.children.length === 0) || {}).textContent || ''");
    results.push(`daemon: ${daemonUp ? 'connected' : `unreachable: ${bannerText}`}`);
    check(daemonUp, 'the packaged session daemon never connected');
    const sessiondStore = fs.existsSync(path.join(tmp, 'sessiond'));
    results.push(`isolated daemon store created: ${sessiondStore}`);
    check(sessiondStore, 'the packaged daemon did not start in its isolated store');
    const views = await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].map((button) => button.getAttribute('aria-label'))");
    results.push(`views: ${views.join(', ')}`);
    check(views.includes('Agents') && views.includes('Tasks'), 'the main views are missing');
    await cdp.shot('1-packaged-app');
  } catch (error) {
    failures.push(error.message);
  } finally {
    await sleep(500);
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  const verdict = failures.length ? `FAIL\n${failures.join('\n')}` : 'PASS';
  const report = `${verdict}\n\n${results.join('\n')}\nscreenshots and app log: ${OUT}\n`;
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
