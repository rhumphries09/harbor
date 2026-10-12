'use strict';

// Drive the phone client against an ISOLATED harbor-server composition with
// synthetic sessions (no real daemon, history, transcripts or token), in a
// private headless Chromium at iPhone 14 size, and save screenshots of what
// changed on 2026-10-11: the header's session facts, the drawer's live rows,
// the "Reconnecting" pill, and a cold boot painting from the phone cache.
//
//   node app/scripts/drive-phone-return-win.js <out-dir>
//
// Synthetic only: every title, prompt, folder and id below is made up.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { chromium, devices } = require('playwright');
const { composeServer } = require('../src/server/compose.js');

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'phone-return-drive'));
const APP = path.resolve(__dirname, '..');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-return-'));
  const contextDir = path.join(root, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'user-data'), { recursive: true });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, profiles: [{ id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE', provider: 'claude', configHome: path.join(root, 'home'), email: null, isDefault: true }] }));

  const now = Date.now();
  const LIVE = '11111111-1111-4111-8111-111111111111';
  const IDLE = '22222222-2222-4222-8222-222222222222';
  const transcriptPath = path.join(root, `${LIVE}.jsonl`);
  const t0 = new Date(now - 95_000).toISOString();
  fs.writeFileSync(transcriptPath, [
    { type: 'user', uuid: 'u1', timestamp: new Date(now - 600_000).toISOString(), message: { role: 'user', content: 'Add a retry to the sample uploader' } },
    { type: 'assistant', uuid: 'a1', timestamp: new Date(now - 590_000).toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Added a bounded retry with backoff to the uploader, and a test for the third failure.' }], usage: { input_tokens: 10, cache_read_input_tokens: 120000, output_tokens: 900 } } },
    { type: 'user', uuid: 'u2', timestamp: t0, message: { role: 'user', content: 'Now run the full test suite and fix anything red' } },
    { type: 'assistant', uuid: 'a2', timestamp: new Date(now - 90_000).toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the test suite' } }], usage: { input_tokens: 10, cache_read_input_tokens: 124000, output_tokens: 40 } } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(contextDir, `${LIVE}.json`), JSON.stringify({ used_percentage: 62 }));

  const row = (id, title, ageMin, extra = {}) => ({ id, title, project: 'sample-app', cwd: 'C:/work/sample-app', provider: 'claude', model: 'claude-opus-5-5', lastActiveMs: now - ageMin * 60_000, lastActive: new Date(now - ageMin * 60_000).toISOString(), home: 'personal', ...extra });
  const sessions = [
    row(LIVE, 'Uploader retry and test run', 1, { isLive: true, paneId: 'p1', workspaceId: 'w1', agentStatus: 'working' }),
    row(IDLE, 'Release notes draft', 12, { isLive: true, paneId: 'p2', workspaceId: 'w2', agentStatus: 'idle' }),
    row('33333333-3333-4333-8333-333333333333', 'Fix the date picker bug', 300),
    row('44444444-4444-4444-8444-444444444444', 'Old migration notes', 60 * 24 * 9),
  ];
  for (let i = 0; i < 3000; i += 1) sessions.push(row(`hist-${i}`, `Archived task ${i}`, 60 * 24 * (5 + (i % 300))));
  fs.writeFileSync(path.join(contextDir, `${IDLE}.json`), JSON.stringify({ used_percentage: 81 }));
  const state = { model: { projects: [{ label: 'sample-app', sessions, hasLive: true }], liveProjects: ['sample-app'] }, historyCount: sessions.length, indexerSessionCount: sessions.length };

  const sidebar = {
    emitter: new EventEmitter(), async start() {}, close() {},
    getState: () => state,
    getSessionMeta: async (id) => (id === LIVE ? { path: transcriptPath, cwd: root, provider: 'claude', home: 'personal' } : null),
  };
  const env = { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_CONTEXT_DIR: contextDir, HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'), HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'), HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts.json'), HARBOR_TASKS_FILE: path.join(root, 'tasks.json'), HARBOR_CONFIG_FILE: configFile };
  const composed = await composeServer({
    userDataDir: path.join(root, 'user-data'), env, sidebar,
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => true },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
    terminalBridge: { emitter: new EventEmitter(), start() {}, close() {} },
    sessionSend: { emitter: new EventEmitter(), getWorkMeter: async () => ({ verb: 'Testing', elapsed: '1m 35s', tokens: '↓ 3.1k', thinking: false }), getMenu: async () => null, getQueueState: () => ({ count: 0 }) },
    allowedTailnetLogins: [], selfOriginHosts: ['127.0.0.1'],
    webDist: path.join(APP, 'dist-web'),
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const results = {};
  const browser = await chromium.launch({ headless: true });
  try {
    const { defaultBrowserType, ...iphone } = devices['iPhone 14'];
    void defaultBrowserType;
    const context = await browser.newContext(iphone);
    const page = await context.newPage();
    let wsBytes = 0;
    page.on('websocket', (ws) => ws.on('framereceived', (f) => { wsBytes += Buffer.byteLength(String(f.payload)); }));
    await page.goto(`${base}/#token=${composed.token}&url=${encodeURIComponent(base)}`);
    await page.waitForSelector('.hdr-meta', { timeout: 20000 });
    await page.waitForTimeout(2500);
    results.connectBytes = wsBytes;
    await page.screenshot({ path: path.join(OUT, '1-header-working.png') });
    results.headerText = await page.textContent('.hdr-meta');
    await page.click('.hdr-session');
    await page.waitForSelector('.session-browser', { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '2-drawer.png') });
    results.drawerRows = await page.$$eval('.session-row', (els) => els.length);
    results.drawerTitles = await page.$$eval('.session-row .session-title', (els) => els.map((e) => e.textContent));
    results.serverTitles = (await composed.router.call('sidebar:get-state')).model.projects.flatMap((p) => p.sessions.map((s) => s.title));
    results.phoneHeldTitles = await page.evaluate(() => {
      const raw = localStorage.getItem('harbor-mobile-cache-v1:sidebar');
      const model = raw ? JSON.parse(raw).model : null;
      return model ? model.projects.flatMap((p) => p.sessions.map((s) => `${s.title}|live=${Boolean(s.isLive)}|ms=${s.lastActiveMs}`)) : null;
    });
    fs.writeFileSync(path.join(OUT, 'phone-held-model.json'), await page.evaluate(() => localStorage.getItem('harbor-mobile-cache-v1:sidebar')));
    results.browserPrefs = await page.evaluate(() => Object.keys(localStorage).filter((k) => /browser|prefs|filter/i.test(k)).map((k) => `${k}=${localStorage.getItem(k)}`));
    await page.click('.session-browser-close');
    // Cold boot from cache: a second page whose socket cannot connect (the
    // server unreachable) must still paint the cached list and conversation,
    // with the small "Reconnecting" pill rather than the error panel.
    const cold = await context.newPage();
    // The socket is refused outright, as when the app returns with no route to the server.
    await cold.routeWebSocket(/\/ws/, (ws) => { ws.close({ code: 4001, reason: 'drive: server unreachable' }); });
    await cold.goto(`${base}/`);
    await cold.waitForTimeout(1200);
    await cold.screenshot({ path: path.join(OUT, '3-cold-boot-from-cache.png') });
    results.coldBootHasSession = Boolean(await cold.$('.hdr-title'));
    results.coldBootTitle = await cold.textContent('.hdr-title').catch(() => null);
    const pill = await cold.$('.connection-banner.reconnecting');
    results.reconnectingPill = Boolean(pill);
    results.coldBootError = await cold.evaluate(() => /could not be displayed/i.test(document.body.innerText));
    results.coldBootStatus = await cold.textContent('.hdr-status').catch(() => null);
    await cold.screenshot({ path: path.join(OUT, '4-reconnecting.png') });
  } finally {
    await browser.close();
    await composed.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
