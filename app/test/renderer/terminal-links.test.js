'use strict';

// A click on an OSC 8 link in the raw >_ terminal (2026-10-18). Without a
// linkHandler, xterm 5.5 shows a native confirm() and opens a blank window that
// main denies, so the link never opened. The handler turns the click into the
// same new-window request a conversation link makes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { terminalLinkHandler } = require('../../src/renderer/terminal/terminal-links.cjs');

test('a click on a terminal link asks for a new window at that address, with no confirm box', () => {
  const opened = [];
  let prevented = 0;
  const handler = terminalLinkHandler((...args) => opened.push(args));
  handler.activate({ preventDefault: () => { prevented += 1; } }, 'https://example.invalid/a/very/long/path');
  assert.deepEqual(opened, [['https://example.invalid/a/very/long/path', '_blank', 'noopener']]);
  assert.equal(prevented, 1);
});

test('an empty or missing address opens nothing', () => {
  const opened = [];
  const handler = terminalLinkHandler((...args) => opened.push(args));
  for (const uri of ['', undefined, null, 42]) handler.activate({}, uri);
  handler.activate(undefined, 'https://example.invalid/x');
  assert.deepEqual(opened, [['https://example.invalid/x', '_blank', 'noopener']]);
});

// The pane must actually pass the handler: xterm falls back to its confirm()
// default the moment the option is missing.
test('XtermPane gives its terminal this link handler', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/terminal/XtermPane.jsx'), 'utf8');
  assert.match(src, /import terminalLinks from '\.\/terminal-links\.cjs';/);
  assert.match(src, /linkHandler: terminalLinks\.terminalLinkHandler\(\(\.\.\.args\) => window\.open\(\.\.\.args\)\),/);
});
