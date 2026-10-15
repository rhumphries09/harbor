'use strict';

// The OBSERVING menu poll (getMenu `observe`, 2026-10-14). A window showing
// its raw terminal still polls for dialogs so the taskbar can turn amber, but
// the human is looking at that terminal and may be typing into it, so the poll
// must never send a key or resize the pane. Two-sided on purpose: each spec
// runs the same screen without `observe` first and requires the key or the
// resize to happen, so a pass cannot come from a harness that never reaches
// the code that presses keys.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');
const { FakeAskDialog } = require('../support/fake-ask-dialog.js');
const { fixture } = require('../support/permission-dialog-fixtures.js');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };

function harness(screen, input = () => {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-menu-observe-'));
  tempDirs.push(stateDir);
  const sent = [];
  const sized = [];
  const deps = {
    snapshot: async () => ({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1', label: 'harbor' }] }),
    readPane: async () => screen(),
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'pane-1' }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_paneId, text) => { sent.push(text); input(text); return { ok: true }; },
      ensureDialogSize: async (paneId, opts) => { sized.push({ paneId, ...opts }); return { ok: true }; },
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd: 'C:/dev/harbor' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'harbor',
    sleep: async () => {},
    setXClipboardImage: async () => {},
    captureDir: path.join(stateDir, 'unrecognized-dialogs'),
    sendLogFile: path.join(stateDir, 'send-log.jsonl'),
  };
  return { send: createSessionSend(deps), sent, sized };
}

const ASK = [
  {
    header: 'Finish approach',
    question: 'How do you want me to produce the file?',
    multiSelect: false,
    options: [
      { label: 'Reassemble', description: 'Reassemble the cleaned data.' },
      { label: 'Show me first', description: 'Display the cleaned data.' },
    ],
  },
  {
    header: 'Delivery',
    question: 'How should I hand it off? (pick any)',
    multiSelect: true,
    options: [
      { label: 'File and note', description: 'Both.' },
      { label: 'Just the file', description: 'Only the file.' },
    ],
  },
];

test('a guard permission prompt is reported by an observing poll, and the pane is not resized', async () => {
  const screen = fixture('guard');
  const normal = harness(() => screen);
  const shown = await normal.send.getMenu({ pane });
  assert.ok(shown?.permission, 'the card poll reads the guard prompt');
  assert.ok(normal.sized.length > 0, 'the card poll sizes the pane for dialogs (the other side of this spec)');

  const watched = harness(() => screen);
  const seen = await watched.send.getMenu({ pane, observe: true });
  assert.ok(seen?.permission, 'the observing poll sees the same prompt');
  assert.equal(seen.options.length, 2);
  assert.deepEqual(watched.sized, [], 'the raw terminal owns the pane size');
  assert.deepEqual(watched.sent, [], 'and nothing was typed');
});

test('an observing poll never walks a multi-question dialog', async () => {
  const walked = new FakeAskDialog(ASK, { startAt: 1 });
  const normal = harness(() => walked.screen(), (text) => walked.input(text));
  await normal.send.getMenu({ pane });
  assert.ok(normal.sent.length > 0, 'the card poll walks the batch once (the other side of this spec)');

  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  const watched = harness(() => dialog.screen(), (text) => dialog.input(text));
  const menu = await watched.send.getMenu({ pane, observe: true });
  assert.ok(menu?.options?.length, 'the dialog is still reported');
  assert.deepEqual(watched.sent, [], 'no key reached the terminal');
  assert.equal(dialog.q, 1, 'the dialog stayed on the question the human was on');
});

test('an observing poll does not press Enter through a first-run notice', async () => {
  const notice = [
    'Welcome to Claude Code v2.1.300',
    '',
    ' Logged in as you@example.com',
    ' Login successful. Press Enter to continue…',
  ].join('\n');
  const normal = harness(() => notice);
  assert.equal(await normal.send.getMenu({ pane }), null);
  assert.ok(normal.sent.length > 0, 'the card poll advances the notice (the other side of this spec)');

  const watched = harness(() => notice);
  assert.equal(await watched.send.getMenu({ pane, observe: true }), null, 'a notice is not a question');
  assert.deepEqual(watched.sent, [], 'and the observing poll pressed nothing');
});
