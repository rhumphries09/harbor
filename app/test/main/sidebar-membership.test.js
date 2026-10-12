'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const { fixture, row, pane, tick, rowsOf } = require('./sidebar-round3-fixture.cjs');

test('idle delegation patches immediately remove and restore rail membership', async (t) => {
  let linked = false;
  const delegationIndex = { scan: async () => ({ parents: [], providers: [], built: { groups: [], delegatedBy: linked ? { child: 'parent' } : {}, dispatches: [{ resumeId: 'child' }] } }), close() {} };
  const { bridge } = await fixture(t, { rows: [row('parent'), row('child')], delegationIndex });
  assert.ok(rowsOf(bridge).some((r) => r.id === 'child'));
  linked = true; await bridge.refreshDelegations();
  assert.ok(!rowsOf(bridge).some((r) => r.id === 'child'), 'new helper leaves rail immediately');
  linked = false; await bridge.refreshDelegations();
  assert.ok(rowsOf(bridge).some((r) => r.id === 'child'), 'lost link restores ordinary session immediately');
});
