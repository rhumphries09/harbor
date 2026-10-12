'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subSessionKind, railSessionVisible, listSubSessions } = require('../../src/shared/sub-sessions.cjs');
const fs = require('node:fs');
const path = require('node:path');

test('sub-session classifier separates machine runs from interactive conversations', () => {
  const cases = [
    [{ provider: 'codex', lineage: { kind: 'guardian' } }, 'approval review'],
    [{ provider: 'codex', source: { subagent: 'other' } }, 'approval review'],
    [{ provider: 'codex', lineage: { kind: 'subagent' } }, 'sub-agent'],
    [{ provider: 'codex', lineage: { kind: 'subagent.reviewer' } }, 'sub-agent'],
    [{ provider: 'codex', lineage: { originator: 'codex_exec' } }, 'exec run'],
    [{ provider: 'codex', lineage: { kind: 'exec' } }, 'exec run'],
    [{ provider: 'claude', entrypoint: 'sdk-cli' }, 'headless Claude'],
    [{ provider: 'claude', firstPrompt: 'BATCH TITLE: Sample worker' }, 'batch worker'],
    [{ isChildTask: true }, 'batch worker'],
    [{ provider: 'claude', entrypoint: 'cli' }, null],
    [{ provider: 'claude', entrypoint: 'claude-desktop' }, null],
    [{ provider: 'codex', lineage: { kind: 'cli', originator: 'codex_cli_rs' } }, null],
    [{ provider: 'cursor' }, null],
  ];
  for (const [row, expected] of cases) {
    assert.equal(subSessionKind(row), expected);
    assert.equal(railSessionVisible(row), expected === null);
    assert.equal(railSessionVisible({ ...row, isLive: true }), true, 'live sub-sessions remain reachable');
  }
});

test('Orch pages group by known parent or unlinked project, newest first, bounded and searchable', () => {
  const now = Date.now();
  const rows = [{ id: 'parent', title: 'Human session' }, ...Array.from({ length: 300 }, (_, i) => ({
    id: `sample-${i}`, project: 'Sample project', title: `Run ${i}`, provider: 'claude', entrypoint: 'sdk-cli',
    lastActiveMs: now - i * 3600000, delegatedBy: i % 2 ? 'parent' : null,
  }))];
  const page = listSubSessions(rows, { now, limit: 20 });
  assert.equal(page.total, 169);
  assert.equal(page.nextOffset, 20);
  assert.equal(page.groups.reduce((n, g) => n + g.sessions.length, 0), 20);
  assert.equal(page.groups[0].label, 'Sample project');
  assert.equal(page.groups[1].label, 'Human session');
  assert.deepEqual(page.groups[0].sessions.slice(0, 2).map((s) => s.id), ['sample-0', 'sample-2']);
  const older = listSubSessions(rows, { now, older: true, offset: 200 });
  assert.equal(older.total, 300); assert.equal(older.nextOffset, null);
  const found = listSubSessions(rows, { now, older: true, query: 'Run 299' });
  assert.equal(found.total, 1); assert.equal(found.groups[0].sessions[0].id, 'sample-299');
});

test('classifier JS and CJS twins have the same implementation', () => {
  const read = (ext) => fs.readFileSync(path.join(__dirname, `../../src/shared/sub-sessions.${ext}`), 'utf8')
    .replace("'use strict';\n", '').replace('module.exports = ', 'export ');
  assert.equal(read('js'), read('cjs'));
});
