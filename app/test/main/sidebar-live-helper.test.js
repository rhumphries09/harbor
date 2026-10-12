'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const { fixture, row, pane, tick, rowsOf } = require('./sidebar-round3-fixture.cjs');

test('live resumed helper TUIs are drivable but print, exec and batch workers stay read-only', async (t) => {
  const helpers = [row('codex', { provider: 'codex', lineage: { kind: 'exec' } }), row('claude', { entrypoint: 'sdk-cli' }),
    row('print', { entrypoint: 'sdk-cli' }), row('exec', { provider: 'codex', lineage: { kind: 'exec' } }), row('batch', { title: 'BATCH TITLE: Worker' })];
  const argv = { codex: ['codex.exe', 'resume', 'codex'], claude: ['node', 'claude.js', '--resume', 'claude'], print: ['claude', '-p', '--resume', 'print'], exec: ['codex', 'exec', 'resume', 'exec'], batch: ['claude', '--resume', 'batch'] };
  const { bridge, emit } = await fixture(t, { rows: helpers, panes: helpers.map((r) => pane(r.id, r.id, r.provider || 'claude')), argv });
  assert.equal(bridge.getSession('codex').isLiveInteractive, true);
  assert.equal(bridge.getSession('claude').isLiveInteractive, true);
  for (const id of ['codex', 'claude']) { assert.equal(bridge.isDelegated(id), false); assert.equal(bridge.isDelegatedPane(id), false); }
  for (const id of ['print', 'exec', 'batch']) assert.equal(bridge.isDelegated(id), true);
  assert.equal(bridge.notificationState('codex').delegatedBy, null);
  argv.codex = ['codex.exe', 'exec', 'resume', 'codex'];
  emit({ event: 'pane.agent_detected', data: { pane_id: 'codex', agent: 'codex' } }); await tick();
  assert.equal(bridge.isDelegatedPane('codex'), true, 'replacement headless process revokes input without waiting for the poll');
});
