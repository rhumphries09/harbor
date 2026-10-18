'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LEAN_MODES, TASK_KINDS, DEFAULT_LEAN, normalizeLean, leanMode, taskKind, leanRoute, leanVerdict, seatsFromPlans, cursorFromPlans,
} = require('../../src/shared/provider-lean.cjs');

const seat = (label, weeklyPct) => ({ label, weeklyPct });
// En and em dash, built from code points so this file carries neither.
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
// The seats on 2026-10-05 when Pat stopped an Astra run: personal capped.
const TODAY = [seat('Default', 100), seat('Work', 62), seat('Studio', 41)];
const ROOMY = [seat('Work', 49), seat('Pro', 12.4)];
const FULL = [seat('A', 90), seat('B', 99)];
const CURSOR = { label: 'Cursor', monthlyPct: 0.7 };
const CURSOR_FULL = { label: 'Cursor', monthlyPct: 95 };

test('four settings in slider order, Balanced by default', () => {
  assert.deepEqual(LEAN_MODES.map((m) => m.id), ['claude-only', 'lean-claude', 'balanced', 'lean-openai']);
  assert.deepEqual(LEAN_MODES.map((m) => m.label), ['Claude only', 'Lean Claude', 'Balanced', 'Lean OpenAI']);
  assert.equal(DEFAULT_LEAN, 'balanced');
  for (const bad of [undefined, null, '', 'claude', 'CLAUDE-ONLY', 42, {}]) assert.equal(normalizeLean(bad), 'balanced');
  assert.equal(leanMode('nonsense').id, 'balanced');
  for (const item of [...LEAN_MODES, ...TASK_KINDS]) assert.ok(item.detail && !DASHES.test(item.detail), item.id);
});

test('a kind sits on a side only where that side is better, and says why (Pat, 2026-10-05)', () => {
  assert.deepEqual(TASK_KINDS.map((k) => [k.id, k.side]), [
    ['image', 'gpt'], ['mechanical', 'cursor'], ['connected', 'claude'], ['review', 'claude'], ['general', null],
  ]);
  for (const kind of TASK_KINDS) {
    if (kind.side) assert.ok(typeof kind.why === 'string' && kind.why.length > 10 && !DASHES.test(kind.why), kind.id);
    else assert.equal(kind.why, null);
  }
  // Merely good is not better: writing, planning and judgement are general work.
  assert.match(taskKind('general').detail, /writing, planning/);
  for (const gone of ['visual', 'writing', 'judgement', 'nonsense', undefined]) assert.equal(taskKind(gone).id, 'general', String(gone));
});

test('Claude only keeps every kind on Claude', () => {
  for (const kind of TASK_KINDS) {
    const r = leanRoute('claude-only', kind.id, ROOMY, { large: true });
    assert.equal(r.side, 'claude', kind.id);
    assert.equal(r.seat, null);
  }
});

test('Lean Claude still sends image work to the emptiest GPT seat', () => {
  const image = leanRoute('lean-claude', 'image', TODAY);
  assert.equal(image.side, 'gpt');
  assert.equal(image.seat.label, 'Studio');
  assert.equal(image.reason, 'Claude cannot create or edit images; a GPT seat can.');
  for (const kind of ['connected', 'review', 'general']) {
    assert.equal(leanRoute('lean-claude', kind, ROOMY, { large: true }).side, 'claude', kind);
  }
});

test('Lean OpenAI sends general work, writing included, to GPT but keeps Claude-better kinds on Claude', () => {
  assert.equal(leanRoute('lean-openai', 'general', TODAY).seat.label, 'Studio');
  assert.equal(leanRoute('lean-openai', 'writing', TODAY).side, 'gpt');
  assert.equal(leanRoute('lean-openai', 'image', TODAY).side, 'gpt');
  assert.equal(leanRoute('lean-openai', 'connected', ROOMY).reason, 'GPT seats and Cursor cannot reach the connectors, the live browser or deploys.');
  assert.equal(leanRoute('lean-openai', 'review', ROOMY).reason, 'A different model catches mistakes the author misses.');
});

// Pat, 2026-10-18: Balanced means "work should go where it is best done (visual
// / image stuff goes to gpt, pretty much all else goes to claude)". The
// 2026-10-05 rule that sent large general jobs to a GPT seat with room was
// temporary, and it is gone: a roomy seat no longer pulls general work off Claude.
test('Balanced sends each kind where it is best done and keeps general work on Claude, large or not', () => {
  assert.equal(leanRoute('balanced', 'image', TODAY).side, 'gpt');
  assert.equal(leanRoute('balanced', 'connected', ROOMY).side, 'claude');
  for (const seats of [ROOMY, TODAY, FULL, []]) {
    for (const large of [false, true]) {
      const r = leanRoute('balanced', 'general', seats, { large });
      assert.deepEqual([r.side, r.seat], ['claude', null], `${JSON.stringify(seats)} large=${large}`);
      assert.equal(r.reason, 'Balanced keeps general work on Claude, where it is best done.');
    }
  }
});

test('a nearly full or unknown seat never takes work, whatever the setting', () => {
  for (const mode of ['lean-claude', 'balanced', 'lean-openai']) {
    assert.equal(leanRoute(mode, 'image', FULL).side, 'claude', mode);
    assert.equal(leanRoute(mode, 'image', []).side, 'claude', mode);
    assert.equal(leanRoute(mode, 'image', [seat('Work', null), { label: 'Bad', weeklyPct: Number.NaN }]).side, 'claude', mode);
  }
  assert.equal(leanRoute('lean-openai', 'general', FULL).reason, 'Every GPT seat is at least 90% used.');
  assert.equal(leanRoute('balanced', 'image', [seat('Work', null), seat('Pro', 10)]).seat.label, 'Pro');
});

test('mechanical work goes to Cursor while its month has room, under every setting but Claude only (Pat, 2026-10-05)', () => {
  for (const mode of ['lean-claude', 'balanced', 'lean-openai']) {
    const r = leanRoute(mode, 'mechanical', TODAY, { cursor: CURSOR });
    assert.equal(r.side, 'cursor', mode);
    assert.equal(r.seat.label, 'Cursor');
  }
  assert.equal(leanRoute('claude-only', 'mechanical', TODAY, { cursor: CURSOR }).side, 'claude');
  // Cursor full or unreadable: the job is ordinary general work again, and says why.
  const full = leanRoute('lean-openai', 'mechanical', ROOMY, { cursor: CURSOR_FULL });
  assert.deepEqual([full.side, full.seat.label, full.kind], ['gpt', 'Pro', 'mechanical']);
  assert.match(full.reason, /^Cursor is at least 90% used this month. /);
  const unread = leanRoute('lean-claude', 'mechanical', TODAY, { cursor: null });
  assert.equal(unread.side, 'claude');
  assert.match(unread.reason, /^Cursor's usage could not be read. Heavy lifting leans Claude.$/);
  assert.equal(leanRoute('lean-claude', 'mechanical', TODAY, { cursor: { label: 'Cursor', monthlyPct: null } }).side, 'claude');
  // A lapsed sign-in says so, with the fix, instead of "could not be read".
  const signedOut = leanRoute('balanced', 'mechanical', TODAY, { cursor: { label: 'Cursor', monthlyPct: null, signedOut: true } });
  assert.equal(signedOut.side, 'claude');
  assert.match(signedOut.reason, /^Cursor is signed out; sign it in again with cursor-agent login. /);
  // Cursor never takes image work or general work on its own.
  assert.equal(leanRoute('lean-openai', 'general', TODAY, { cursor: CURSOR }).side, 'gpt');
  assert.equal(leanRoute('lean-claude', 'image', TODAY, { cursor: CURSOR }).side, 'gpt');
});

test('heavily complex mechanical work is not fed to Cursor; it routes as general work (Pat, 2026-10-05)', () => {
  const lc = leanRoute('lean-claude', 'mechanical', TODAY, { cursor: CURSOR, complex: true });
  assert.equal(lc.side, 'claude');
  assert.equal(lc.reason, 'Too complex for Cursor: the changes need judgement or a hard-to-check result. Heavy lifting leans Claude.');
  const lo = leanRoute('lean-openai', 'mechanical', TODAY, { cursor: CURSOR, complex: true });
  assert.deepEqual([lo.side, lo.seat.label], ['gpt', 'Studio'], 'under Lean OpenAI it is general work, so a GPT seat');
  assert.equal(leanRoute('balanced', 'mechanical', TODAY, { cursor: CURSOR, complex: true }).side, 'claude');
  assert.equal(leanRoute('balanced', 'mechanical', TODAY, { cursor: CURSOR, complex: false }).side, 'cursor');
  assert.match(taskKind('mechanical').detail, /only when every change is the same and a simple check proves it/);
});

test('the Right now rows for each setting', () => {
  const rows = (mode, seats, cursor) => leanVerdict(mode, seats, cursor).rows.map((r) => [r.label, r.target, r.note]);
  assert.deepEqual(rows('claude-only', ROOMY, CURSOR), [['All work', 'Claude', null]]);
  assert.deepEqual(rows('lean-claude', TODAY, CURSOR), [
    ['Image work', 'Studio', '41% used this week'],
    ['Simple mechanical work', 'Cursor', '<1% used this month'],
    ['Everything else', 'Claude', null],
  ]);
  assert.deepEqual(rows('balanced', TODAY, CURSOR), [
    ['Image work', 'Studio', '41% used this week'],
    ['Simple mechanical work', 'Cursor', '<1% used this month'],
    ['Everything else', 'Claude', null],
  ]);
  // A roomy GPT seat no longer adds a "Large general jobs" row.
  assert.deepEqual(rows('balanced', ROOMY, CURSOR), [
    ['Image work', 'Pro', '12% used this week'],
    ['Simple mechanical work', 'Cursor', '<1% used this month'],
    ['Everything else', 'Claude', null],
  ]);
  assert.deepEqual(rows('lean-openai', TODAY, CURSOR), [
    ['Image work', 'Studio', '41% used this week'],
    ['Simple mechanical work', 'Cursor', '<1% used this month'],
    ['Connected work and reviews', 'Claude', null],
    ['Everything else', 'Studio', '41% used this week'],
  ]);
  assert.deepEqual(rows('lean-claude', FULL, CURSOR_FULL), [
    ['Image work', 'Claude', 'Every GPT seat is at least 90% used'],
    ['Simple mechanical work', 'Claude', 'Cursor is at least 90% used this month'],
    ['Everything else', 'Claude', null],
  ]);
  const v = leanVerdict('lean-claude', TODAY, CURSOR);
  assert.equal(v.summary, 'Image work: Studio (41% used this week). Simple mechanical work: Cursor (<1% used this month). Everything else: Claude.');
  assert.deepEqual([v.gpt, v.seat.label], ['image', 'Studio']);
  assert.deepEqual([leanVerdict('lean-openai', TODAY, CURSOR).gpt, leanVerdict('balanced', ROOMY, CURSOR).gpt, leanVerdict('claude-only', ROOMY).gpt], ['prefer', 'image', 'off']);
  for (const mode of ['claude-only', 'lean-claude', 'balanced', 'lean-openai']) {
    for (const row of leanVerdict(mode, TODAY, CURSOR).rows) assert.ok(!DASHES.test(JSON.stringify(row)), mode);
  }
});

test('Cursor comes from the same plan-usage payload, monthly window only', () => {
  assert.deepEqual(cursorFromPlans([{ provider: 'cursor', label: 'Cursor', windows: [{ kind: 'monthly', usedPct: 3 }] }]), { label: 'Cursor', monthlyPct: 3, signedOut: false });
  assert.deepEqual(cursorFromPlans([{ provider: 'cursor', label: 'Cursor', unavailable: true, windows: [] }]), { label: 'Cursor', monthlyPct: null, signedOut: false });
  assert.deepEqual(cursorFromPlans([{ provider: 'cursor', label: 'Cursor', unavailable: true, signedOut: true, windows: [] }]), { label: 'Cursor', monthlyPct: null, signedOut: true });
  assert.equal(cursorFromPlans([{ provider: 'codex', label: 'Default', windows: [] }]), null);
  assert.equal(cursorFromPlans(undefined), null);
});

test('seats come from the codex plans of the plan-usage payload, weekly window and reset credits only', () => {
  const plans = [
    { provider: 'claude', label: 'Default', windows: [{ kind: 'weekly', usedPct: 99 }] },
    { provider: 'codex', label: 'Default', windows: [{ kind: 'fiveHour', usedPct: 80 }, { kind: 'weekly', usedPct: 100 }], resets: { available: 2, nextExpiresAt: 1 } },
    { provider: 'codex', label: 'Work', windows: [{ kind: 'fiveHour', usedPct: 3 }], resets: { available: 0, nextExpiresAt: null } },
    { provider: 'codex', label: 'Pro', unavailable: true, windows: [{ kind: 'weekly', usedPct: 5 }], resets: null },
    { provider: 'codex', label: 'Odd', windows: [{ kind: 'weekly', usedPct: 5 }], resets: { available: -1 } },
    { provider: 'cursor', label: 'Cursor', windows: [{ kind: 'monthly', usedPct: 1 }] },
  ];
  assert.deepEqual(seatsFromPlans(plans), [
    { label: 'Default', weeklyPct: 100, resetsAvailable: 2 },
    { label: 'Work', weeklyPct: null, resetsAvailable: 0 },
    { label: 'Pro', weeklyPct: null, resetsAvailable: null },
    { label: 'Odd', weeklyPct: 5, resetsAvailable: null },
  ]);
  assert.deepEqual(seatsFromPlans(undefined), []);
});

// Pat's standing rule (2026-09-16): a GPT seat that is out but holds a reset is
// not out; spend the reset before the work goes to Claude. On Oct 1 and Oct 8
// Studio sat capped with a reset while its work went to Claude.
test('a seat with a reset waiting is not out: it takes the work when no seat has room (2026-10-13)', () => {
  const withReset = (label, weeklyPct, resetsAvailable) => ({ label, weeklyPct, resetsAvailable });
  const OCT8 = [withReset('Default', 100, 0), withReset('Studio', 97, 1), withReset('Work', 100, 0)];
  for (const mode of ['lean-claude', 'balanced', 'lean-openai']) {
    const image = leanRoute(mode, 'image', OCT8);
    assert.deepEqual([image.side, image.seat.label], ['gpt', 'Studio'], mode);
    assert.equal(image.reason, 'Studio is 97% used but has 1 reset waiting; apply one when it runs out.');
  }
  assert.equal(leanRoute('lean-openai', 'general', OCT8).seat.label, 'Studio');
  // Balanced keeps general work on Claude: a waiting reset never pulls it to a GPT seat (Pat, 2026-10-18).
  assert.equal(leanRoute('balanced', 'general', [withReset('Work', 62, 0), withReset('Studio', 100, 2)], { large: true }).side, 'claude');
  assert.equal(leanRoute('balanced', 'general', [withReset('Work', 12, 0), withReset('Studio', 97, 1)], { large: true }).side, 'claude');
  assert.equal(leanRoute('lean-openai', 'general', [withReset('Work', 40, 0), withReset('Studio', 30, 1)]).reason, 'Heavy lifting leans OpenAI.');
  // Zero or unknown resets change nothing.
  for (const resets of [0, null, undefined, -1, 1.5]) {
    assert.equal(leanRoute('lean-openai', 'general', [withReset('A', 95, resets)]).side, 'claude', String(resets));
  }
  // The Right now row says the reset is there.
  assert.deepEqual(leanVerdict('lean-claude', OCT8, CURSOR).rows[0], { label: 'Image work', target: 'Studio', note: '97% used this week, 1 reset waiting' });
});
