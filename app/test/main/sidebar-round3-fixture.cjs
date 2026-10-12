'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const rowsOf = (bridge) => bridge.getState().model.projects.flatMap((p) => p.sessions);
async function fixture(t, { rows = [], panes = [], linker = null, ledger = {}, delegationIndex = null, argv = {} } = {}) {
  const history = new EventEmitter(); Object.assign(history, { listSessions: async () => rows, sessionHomes: async () => ({}) });
  const subscription = new EventEmitter(); subscription.close = () => {};
  let emit;
  const client = {
    bootstrap: async (options) => { emit = options.onEvent; return { snapshot: { workspaces: [{ workspace_id: 'w', label: 'Synthetic project' }], panes }, subscription }; },
    dormantSessions: async () => ledger,
    processInfo: async (id) => ({ foreground_processes: [{ pid: 100, argv: argv[id] || [] }, { pid: 101, argv: ['node', 'synthetic-tool.js'] }] }),
  };
  const bridge = createSidebarBridge({ history, providerHistory: null, providerSessionLinker: linker, delegationIndex, createControlClient: () => client });
  t.after(() => bridge.close()); await bridge.start(); await tick();
  return { bridge, emit: (event) => emit(event) };
}
const row = (id, extra = {}) => ({ id, project: 'Synthetic project', title: id, lastActive: '2026-10-11 10:00', ...extra });
const pane = (id, session, agent = 'claude') => ({ pane_id: id, workspace_id: 'w', agent, agent_session: session ? { kind: 'id', value: session } : null, agent_status: null });

module.exports = { fixture, row, pane, tick, rowsOf };
