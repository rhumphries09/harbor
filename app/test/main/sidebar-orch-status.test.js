'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const { fixture, row, pane, tick, rowsOf } = require('./sidebar-round3-fixture.cjs');

test('Orch uses linked identities, live fallback status and the daemon sleep ledger', async (t) => {
  const linker = { emitter: new EventEmitter(), start() {}, close() {}, apply: (panes) => panes.map((p) => p.pane_id === 'codex-pane' ? { ...p, agent_session: { kind: 'id', value: 'exec' } } : p) };
  const { bridge } = await fixture(t, { linker,
    rows: [row('exec', { provider: 'codex', lineage: { kind: 'exec' } }), row('headless', { entrypoint: 'sdk-cli' }), row('asleep', { entrypoint: 'sdk-cli' })],
    panes: [pane('codex-pane', null, 'codex'), pane('claude-pane', 'headless')], ledger: { asleep: { at: '2026-10-12T00:00:00Z' } },
  });
  const listed = Object.fromEntries(bridge.listSubSessions({ older: true }).groups.flatMap((g) => g.sessions).map((s) => [s.id, s.status]));
  assert.deepEqual(listed, { exec: 'live', headless: 'live', asleep: 'sleeping' });
});
