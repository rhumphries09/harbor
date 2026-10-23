#!/usr/bin/env node
'use strict';

// A stand-in for Claude Code's FULLSCREEN renderer ("tui": "fullscreen", also
// the default for a fresh install), reduced to its scroll contract. Every rule
// below was MEASURED against the real CLI 2.1.303 in an isolated sessiond on
// 2026-10-22 (the record is docs/orchestration/2026-10-22-harness-friction/
// reports/terminal-view.md):
//
//   startup        alternate screen plus mouse reporting (?1049h, then
//                  ?1000h ?1002h ?1003h ?1006h); the CLI keeps its own virtual
//                  scrollback, so the pane's screen has none
//   output         follows the bottom while it is pinned there
//   wheel up       (SGR 64) scrolls the CLI itself and STOPS following; new
//                  output then lands below the view and the view stays put
//   wheel down     (SGR 65) scrolls back; reaching the bottom follows again
//   ctrl+End       (ESC [1;5F, "Jump to bottom (ctrl+End)") follows again; a
//                  no-op when already at the bottom
//   resize         repaints and re-asserts mouse reporting; it does NOT move a
//                  pinned view off the bottom (and does not re-pin a scrolled one)
//
// One test hook stands in for the session's own work (a running turn, a
// background task's report), which the real CLI renders without any typed
// prompt and therefore without re-following: the input "+N" then Enter
// appends N numbered messages.
//
// The last row says "live" or "scrolled" and the message count, so a test can
// read the stand-in's state off the screen the daemon models.
//
// Usage: node fullscreen-claude-standin.js [initial message count]

let total = Math.max(0, Number(process.argv[2]) || 0);
let scrollTop = 0;
let following = true;
const CHROME_ROWS = 2;
const WHEEL_ROWS = 3;

const rows = () => Math.max(CHROME_ROWS + 1, process.stdout.rows || 24);
const cols = () => Math.max(10, process.stdout.columns || 80);
const viewRows = () => rows() - CHROME_ROWS;
const maxTop = () => Math.max(0, total - viewRows());

const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';

function render() {
  if (following) scrollTop = maxTop();
  scrollTop = Math.min(Math.max(0, scrollTop), maxTop());
  let out = '\x1b[?25l';
  for (let row = 0; row < viewRows(); row += 1) {
    const n = scrollTop + row + 1;
    out += `\x1b[${row + 1};1H\x1b[2K${n <= total ? `message ${n}` : ''}`;
  }
  out += `\x1b[${viewRows() + 1};1H\x1b[2K${'-'.repeat(Math.min(cols(), 40))}`;
  out += `\x1b[${viewRows() + 2};1H\x1b[2Kstandin ${following ? 'live' : 'scrolled'} ${total}`;
  out += `\x1b[${viewRows() + 2};1H\x1b[?25h`;
  process.stdout.write(out);
}

let pending = '';
let typed = '';
function onInput(chunk) {
  pending += chunk.toString('utf8');
  for (;;) {
    const mouse = /^\x1b\[<(\d+);\d+;\d+[Mm]/.exec(pending);
    if (mouse) {
      const button = Number(mouse[1]);
      // Like the CLI, a wheel over content that fits the view does nothing.
      if (maxTop() === 0) { pending = pending.slice(mouse[0].length); continue; }
      if (button === 64) { following = false; scrollTop -= WHEEL_ROWS; }
      else if (button === 65) {
        scrollTop += WHEEL_ROWS;
        if (scrollTop >= maxTop()) following = true;
      }
      pending = pending.slice(mouse[0].length);
      render();
      continue;
    }
    if (pending.startsWith('\x1b[1;5F')) {
      following = true;
      pending = pending.slice('\x1b[1;5F'.length);
      render();
      continue;
    }
    if (pending.startsWith('\x1b')) {
      // Some other sequence (focus reports, keys this stand-in does not model):
      // wait for the rest of it, then drop it whole.
      const other = /^\x1b(\[[0-9;?<>]*[ -/]*[@-~]|O.|[^[O])/.exec(pending);
      if (!other) return;
      pending = pending.slice(other[0].length);
      continue;
    }
    if (!pending) return;
    const ch = pending[0];
    pending = pending.slice(1);
    if (ch === '\r' || ch === '\n') {
      const hook = /^\+(\d+)$/.exec(typed.trim());
      typed = '';
      if (hook) { total += Number(hook[1]); render(); }
    } else {
      typed += ch;
    }
  }
}

process.stdout.write(`\x1b[?1049h${MOUSE_ON}\x1b[2J`);
render();
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', onInput);
process.stdout.on('resize', () => { process.stdout.write(MOUSE_ON); render(); });
// Never outlive a forgotten harness by long.
setTimeout(() => process.exit(0), 10 * 60 * 1000).unref();
process.stdin.resume();
