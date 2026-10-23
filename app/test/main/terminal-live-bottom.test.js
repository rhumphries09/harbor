'use strict';

// The >_ view's return to the live bottom (2026-10-22), pinned at the bridge.
// A fullscreen Claude Code owns its scroll position, so a wheel in a >_ peek
// left the session's terminal parked on an old screen long after the view
// closed (terminal-bridge.js LIVE_BOTTOM_KEY). The bridge now sends the CLI's
// own "Jump to bottom" key (ctrl+End) when a claude pane's view opens and when
// it closes. These specs pin who gets it, when, and when not; the symptom
// itself is reproduced end to end against a real daemon in
// test/daemon/terminal-live-bottom.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');
const { SessionStreamSupervisor } = require('../../src/main/session-daemon/streams.js');

const CTRL_END = '\x1b[1;5F';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(panes, { relayOk = true } = {}) {
  const log = [];
  const subscription = Object.assign(new EventEmitter(), { close() {} });
  const snapshot = {
    workspaces: panes.map((p) => ({ workspace_id: p.pane_id })),
    tabs: panes.map((p) => ({ tab_id: p.pane_id, workspace_id: p.pane_id })),
    panes,
    layouts: panes.map((p) => ({ tab_id: p.pane_id, panes: [p] })),
  };
  class FakeDaemon {
    async bootstrap() { return { snapshot, subscription }; }
    async snapshot() { return { snapshot }; }
    async readPane(paneId) { log.push(['backfill', paneId]); return { read: { text: 'screen' } }; }
    async sendInput(paneId, input) { log.push(['input', paneId, input.text]); return { accepted: true }; }
    focusPane() { return Promise.resolve({ ok: true }); }
    focusWorkspace() { return Promise.resolve({ ok: true }); }
  }
  const supervisor = new EventEmitter();
  supervisor.attachObserver = (paneId) => {
    log.push(['observe', paneId]);
    // The relay comes up a beat later, as the daemon's reply does.
    return { paneId, ready: tick().then(() => { log.push(['observing', paneId]); return relayOk; }) };
  };
  log.supervisor = supervisor;
  supervisor.detach = (paneId) => log.push(['detach', paneId]);
  supervisor.releaseControl = () => {};
  supervisor.reset = () => log.push(['reset']);
  supervisor.resize = () => {};
  supervisor.ensureDialogSize = async () => ({ ok: true });
  const bridge = createTerminalBridge({
    createControlClient: () => new FakeDaemon(),
    createStreamSupervisor: () => supervisor,
    env: { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond' },
    sessionStorePolicy: { allowed: true },
  });
  bridge.emitter.on('error', () => {});
  return { bridge, log, subscription };
}

const keysTo = (log, paneId) => log.filter(([kind, id]) => kind === 'input' && id === paneId).map(([, , text]) => text);

test('opening a claude pane\'s >_ view sends ctrl+End once the relay is up, before the backfill paints', async () => {
  const { bridge, log } = harness([{ pane_id: 'c1', agent: 'claude' }]);
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1', cols: 100, rows: 30 }]);
  assert.deepEqual(keysTo(log, 'c1'), [CTRL_END]);
  const order = log.filter(([, id]) => id === 'c1').map(([kind]) => kind);
  assert.deepEqual(order, ['observe', 'observing', 'input', 'backfill'],
    'the key waits for the relay, so the CLI\'s repaint reaches the view as frames');
  bridge.close();
});

test('closing the view sends it again, so a scroll inside the peek does not outlive it', async () => {
  const { bridge, log } = harness([{ pane_id: 'c1', agent: 'claude' }]);
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1', cols: 100, rows: 30 }]);
  await bridge.setVisiblePanes([]);
  assert.deepEqual(keysTo(log, 'c1'), [CTRL_END, CTRL_END]);
  const order = log.filter(([, id]) => id === 'c1').map(([kind]) => kind);
  assert.deepEqual(order.slice(-2), ['detach', 'input']);
  bridge.close();
});

test('codex, cursor and unidentified panes are never sent it', async () => {
  const { bridge, log } = harness([
    { pane_id: 'x1', agent: 'codex' },
    { pane_id: 'u1', agent: 'cursor' },
    { pane_id: 'n1', agent: null },
  ]);
  await bridge.start();
  const all = [{ paneId: 'x1' }, { paneId: 'u1' }, { paneId: 'n1' }, { paneId: 'gone' }];
  await bridge.setVisiblePanes(all);
  await bridge.setVisiblePanes([]);
  assert.deepEqual(log.filter(([kind]) => kind === 'input'), []);
  assert.equal(log.filter(([kind]) => kind === 'backfill').length, 4, 'every view still opened');
  bridge.close();
});

test('a send in flight keeps the pane: closing the view mid-send sends nothing', async () => {
  const { bridge, log } = harness([{ pane_id: 'c1', agent: 'claude' }]);
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1' }]);
  bridge.holdControl('c1');
  await bridge.setVisiblePanes([]);
  bridge.releaseControlHold('c1');
  assert.deepEqual(keysTo(log, 'c1'), [CTRL_END], 'only the open sent it; the send\'s own submit re-follows');
  bridge.close();
});

test('a pane another controller owns is never sent it, on open or close (review 2026-10-22)', async () => {
  const { bridge, log } = harness([{ pane_id: 'c1', agent: 'claude' }]);
  await bridge.start();
  // The daemon refused this window control because another terminal client holds it.
  log.supervisor.emit('denied', { paneId: 'c1', reason: 'controlled by terminal client' });
  await bridge.setVisiblePanes([{ paneId: 'c1' }]);
  await bridge.setVisiblePanes([]);
  await tick();
  assert.deepEqual(keysTo(log, 'c1'), [], 'external control means hands off');
  bridge.close();
});

test('a relay that failed to come up gets no key, and the view still opens (review 2026-10-22)', async () => {
  const { bridge, log } = harness([{ pane_id: 'c1', agent: 'claude' }], { relayOk: false });
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1' }]);
  assert.deepEqual(keysTo(log, 'c1'), [], 'no repaint key into a view whose relay is not up');
  assert.equal(log.filter(([kind]) => kind === 'backfill').length, 1, 'the view still backfills');
  bridge.close();
});

test('a daemon reconnect re-attaches without moving a reader\'s place', async () => {
  const { bridge, log, subscription } = harness([{ pane_id: 'c1', agent: 'claude' }]);
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1' }]);
  assert.deepEqual(keysTo(log, 'c1'), [CTRL_END]);
  subscription.emit('close');
  bridge.reconnectNow();
  for (let i = 0; i < 20 && log.filter(([kind]) => kind === 'observe').length < 2; i += 1) await tick();
  await tick();
  assert.equal(log.filter(([kind]) => kind === 'observe').length, 2, 'the pane was re-attached');
  assert.deepEqual(keysTo(log, 'c1'), [CTRL_END], 'a re-attach is not an open');
  bridge.close();
});

test('closing the view mid-send keeps the send\'s control until its last keystroke (review round 3, 2026-10-22)', async () => {
  // The close path released control unconditionally, so a send that held the
  // pane failed its next keystroke with "pane is not focused for control".
  const { bridge, log } = harness([{ pane_id: 'c1', agent: 'claude' }]);
  let released = 0;
  log.supervisor.acquireControl = () => {};
  log.supervisor.sendInput = () => {};
  log.supervisor.releaseControl = () => { released += 1; };
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'c1' }]);
  await bridge.focusPane({ paneId: 'c1' });
  bridge.holdControl('c1');
  assert.deepEqual(bridge.sendInput('c1', 'before'), { ok: true });
  await bridge.setVisiblePanes([]);
  assert.deepEqual(bridge.sendInput('c1', 'after'), { ok: true }, 'the held send keeps typing after the view closed');
  assert.equal(released, 0, 'no release while the lease is held');
  bridge.releaseControlHold('c1');
  assert.equal(released, 1, 'the deferred release lands when the last lease drops');
  assert.equal(bridge.sendInput('c1', 'later').ok, false, 'and then control is really gone');
  bridge.close();
});

test('the supervisor\'s observer entry says when the relay is up, and never rejects', async () => {
  const replies = [];
  const client = {
    onEvent() { return () => {}; },
    request: (verb, params) => new Promise((resolve, reject) => replies.push({ verb, params, resolve, reject })),
    close() {},
  };
  const supervisor = new SessionStreamSupervisor({ client });
  supervisor.on('error', () => {});
  const ok = supervisor.attachObserver('p1');
  const bad = supervisor.attachObserver('p2');
  replies[0].resolve({ observing: true });
  replies[1].reject(new Error('session not found'));
  assert.equal(await ok.ready, true);
  assert.equal(await bad.ready, false);
});
