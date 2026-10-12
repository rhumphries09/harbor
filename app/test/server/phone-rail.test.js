'use strict';

// The phone downloads only what its drawer shows (2026-10-11: a reconnect used
// to fetch 3.96 MB of all history, twice). Synthetic rows only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectRail, createContextReader } = require('../../src/server/phone-rail.js');

const NOW = Date.UTC(2026, 9, 11, 18, 0, 0);
const HOUR = 3_600_000;

function history({ rows = 5000, recent = 40, live = 6 } = {}) {
  const projects = [];
  for (let p = 0; p < 50; p += 1) projects.push({ label: `Project ${p}`, sessions: [], isOrchestration: false });
  for (let i = 0; i < rows; i += 1) {
    const ageHours = i < recent ? i : 49 + (i % 4000);
    projects[i % 50].sessions.push({
      id: `row-${i}`, title: `Sample task ${i}`, firstPrompt: `Prompt text ${i} about widgets`,
      project: `Project ${i % 50}`, cwd: `C:/work/project-${i % 50}`,
      lastActiveMs: NOW - ageHours * HOUR, isLive: i >= recent && i < recent + live,
    });
  }
  return { model: { projects, liveProjects: [], grouping: 'project' }, historyCount: rows, indexerSessionCount: rows };
}

const ids = (state) => state.model.projects.flatMap((p) => p.sessions.map((s) => s.id));

test('the default projection is live rows plus the last 48 hours, and it is small', () => {
  const full = history();
  const out = projectRail(full, {}, { now: NOW });
  const kept = new Set(ids(out));
  for (let i = 0; i < 40; i += 1) assert.ok(kept.has(`row-${i}`), `recent row-${i} kept`);
  for (let i = 40; i < 46; i += 1) assert.ok(kept.has(`row-${i}`), `live row-${i} kept though old`);
  assert.equal(kept.size, 46);
  assert.equal(out.phone.totalRows, 5000);
  assert.equal(out.phone.shownRows, 46);
  const bytes = Buffer.byteLength(JSON.stringify(out));
  assert.ok(bytes < 0.03 * Buffer.byteLength(JSON.stringify(full)), `projection ${bytes} bytes is a sliver of the full model`);
  assert.ok(bytes < 300_000, 'a reconnect transfers under 300 KB of session list');
  assert.equal(out.historyCount, 5000, 'counts pass through for the phone to say how much history exists');
});

test('a waiting or blocked session is kept whatever its age', () => {
  const full = history({ recent: 0, live: 0 });
  full.model.projects[3].sessions[0].needsAnswer = true;
  full.model.projects[4].sessions[0].blocked = true;
  assert.deepEqual(ids(projectRail(full, {}, { now: NOW })).sort(), [full.model.projects[3].sessions[0].id, full.model.projects[4].sessions[0].id].sort());
});

test('wider windows and All are served on request', () => {
  const full = history();
  const week = projectRail(full, { days: 7 }, { now: NOW });
  assert.ok(week.phone.shownRows > 46);
  assert.ok(ids(week).every((id) => {
    const row = full.model.projects.flatMap((p) => p.sessions).find((s) => s.id === id);
    return row.isLive || row.lastActiveMs >= NOW - 7 * 24 * HOUR;
  }));
  const all = projectRail(full, { days: 'all', limit: 1000 }, { now: NOW });
  assert.equal(all.phone.shownRows, 1000);
  assert.equal(all.phone.truncated, true);
});

test('search reaches all history, matches prompt and folder text, and never cuts a live row', () => {
  const full = history();
  const hit = projectRail(full, { query: 'prompt text 4321' }, { now: NOW });
  assert.deepEqual(ids(hit), ['row-4321']);
  const folder = projectRail(full, { query: 'project-7', limit: 10 }, { now: NOW });
  assert.equal(folder.phone.shownRows, 10);
  assert.equal(folder.phone.truncated, true);
  const wide = projectRail(full, { query: 'widgets', limit: 5 }, { now: NOW });
  const kept = ids(wide);
  for (let i = 40; i < 45; i += 1) assert.ok(kept.includes(`row-${i}`), 'live rows rank first under the cap');
});

test('project order and shape are kept, and empty projects drop out', () => {
  const full = history();
  const out = projectRail(full, {}, { now: NOW });
  const labels = out.model.projects.map((p) => p.label);
  assert.deepEqual(labels, full.model.projects.map((p) => p.label).filter((l) => labels.includes(l)));
  assert.ok(out.model.projects.every((p) => p.sessions.length === p.sessionCount && p.sessions.length > 0));
  assert.equal(out.model.grouping, 'project');
});

test('live rows carry the statusline tee percentage, and only a real one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-rail-ctx-'));
  try {
    fs.writeFileSync(path.join(dir, 'row-40.json'), JSON.stringify({ used_percentage: 61.6 }));
    fs.writeFileSync(path.join(dir, 'row-41.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'row-0.json'), JSON.stringify({ used_percentage: 12 }));
    const out = projectRail(history(), {}, { now: NOW, contextPct: createContextReader(dir) });
    const byId = new Map(out.model.projects.flatMap((p) => p.sessions).map((s) => [s.id, s]));
    assert.equal(byId.get('row-40').contextPct, 62);
    assert.equal('contextPct' in byId.get('row-41'), false, 'an unreadable tee is no number, never a guess');
    assert.equal('contextPct' in byId.get('row-42'), false, 'no tee, no number');
    assert.equal('contextPct' in byId.get('row-0'), false, 'only live rows are stamped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed state projects to an empty rail instead of throwing', () => {
  assert.deepEqual(projectRail({ model: [] }, {}).model.projects, []);
  assert.deepEqual(projectRail(null, {}).model.projects, []);
});
