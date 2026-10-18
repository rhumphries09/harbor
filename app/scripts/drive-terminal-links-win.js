// Terminal link drive (2026-10-18). Claude CLI 2.1.302 makes every row of a
// wrapped URL one OSC 8 link, and a click on such a link in Harbor's raw >_
// view never opened anything: with no linkHandler, xterm 5.5 shows a native
// confirm() and then opens a BLANK window, which the main window's
// setWindowOpenHandler denies because it is not http(s).
//
// This drive loads the real xterm package and the real terminal-links.cjs in
// the repo's hidden capture host (offscreen, unfocusable, never shown; nothing
// reaches the desktop), writes a link exactly as the CLI does
// (ESC ] 8 ; ; <url> BEL <text> ESC ] 8 ; ; BEL), and clicks it with a real
// mouse event, twice:
//   1. with the handler XtermPane passes: the click must ask for a new window
//      at the link's address (the request main hands to the browser opener,
//      the path drive-link-freeze-win.js proves for conversation links) and
//      must never show confirm();
//   2. control, with no handler: xterm's own default must show confirm() and
//      never request the link's address, so step 1 cannot pass by accident.
// window.open and confirm are stubbed in the page to record calls.
// Usage (from app/): node scripts/drive-terminal-links-win.js
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const APP = path.resolve(__dirname, '..');
const { captureEnv, hiddenMain, closeApp, assertHidden } = require('./lib/capture-runtime.cjs');
const { prepareRoot } = require('./lib/demo-corpus.cjs');
const { _electron: electron } = require('../node_modules/@playwright/test');

const URL_UNDER_TEST = 'https://example.invalid/harbor-terminal-link-drive';
const LINK_TEXT = 'example.invalid/doc';
const PREFIX = 'see ';

function pageHtml(withHandler) {
  const asset = (p) => pathToFileURL(path.join(APP, p)).href;
  const written = `${PREFIX}\\x1b]8;;${URL_UNDER_TEST}\\x07${LINK_TEXT}\\x1b]8;;\\x07 done`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${asset('node_modules/@xterm/xterm/css/xterm.css')}">
<style>html,body{margin:0;background:#0b0d11}#t{width:720px;height:240px}</style></head>
<body><div id="t"></div>
<script>window.module = { exports: {} };</script>
<script src="${asset('src/renderer/terminal/terminal-links.cjs')}"></script>
<script>window.terminalLinks = window.module.exports; delete window.module;</script>
<script src="${asset('node_modules/@xterm/xterm/lib/xterm.js')}"></script>
<script>
  window.__opened = []; window.__confirms = 0;
  window.open = (...args) => { window.__opened.push(args); return null; };
  window.confirm = () => { window.__confirms += 1; return false; };
  const options = { cols: 60, rows: 6, fontSize: 13 };
  ${withHandler ? 'options.linkHandler = window.terminalLinks.terminalLinkHandler((...args) => window.open(...args));' : ''}
  const term = new Terminal(options);
  term.open(document.getElementById('t'));
  window.__term = term;
  term.write('${written}', () => { window.__ready = true; });
</script></body></html>`;
}

async function clickLink(root, withHandler) {
  const file = path.join(root, `page-${withHandler ? 'handler' : 'control'}.html`);
  fs.writeFileSync(file, pageHtml(withHandler));
  const app = await electron.launch({
    executablePath: require('../node_modules/electron'),
    args: [hiddenMain, `--user-data-dir=${path.join(root, 'userData')}`],
    cwd: APP,
    timeout: 120000,
    env: { ...captureEnv(root), HARBOR_SHOT_ROOT: root, HARBOR_CAPTURE_HTML: file, HARBOR_CAPTURE_WIDTH: '760', HARBOR_CAPTURE_HEIGHT: '280' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
    await assertHidden(app);
    const box = await page.evaluate((col) => {
      const term = window.__term;
      const cell = term._core._renderService.dimensions.css.cell;
      const screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { x: screen.left + (col + 0.5) * cell.width, y: screen.top + 0.5 * cell.height };
    }, PREFIX.length + 3);
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(250);
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(500);
    return await page.evaluate(() => ({ opened: window.__opened, confirms: window.__confirms }));
  } finally {
    await closeApp(app);
  }
}

(async () => {
  const root = prepareRoot(path.join(APP, 'verify', 'harbor-terminal-links'));
  fs.mkdirSync(path.join(root, 'userData'), { recursive: true });
  const problems = [];
  const handler = await clickLink(root, true);
  console.log(`with the handler: ${JSON.stringify(handler)}`);
  const asked = JSON.stringify(handler.opened) === JSON.stringify([[URL_UNDER_TEST, '_blank', 'noopener']]);
  if (!asked) problems.push('the click did not ask for exactly one new window at the link address');
  if (handler.confirms !== 0) problems.push('the click showed confirm()');
  const control = await clickLink(root, false);
  console.log(`control, no handler: ${JSON.stringify(control)}`);
  if (control.confirms < 1) problems.push('control: xterm default did not show confirm(), so the click may not have reached the link');
  if (control.opened.some((args) => args[0] === URL_UNDER_TEST)) problems.push('control: the default opened the link address');
  if (problems.length) {
    console.log(`PROOF FAILED:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('PROOF OK: a click on a terminal link asks for a new window at its address with no confirm box, and without the handler xterm shows confirm() and opens nothing at that address');
})().catch((error) => { console.error(error); process.exit(1); });
