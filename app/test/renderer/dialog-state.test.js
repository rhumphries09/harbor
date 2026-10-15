'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDialogStore, liveDialog } = require('../../src/renderer/stage/dialog-state.cjs');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { fixture } = require('../support/permission-dialog-fixtures.js');
const { runStateCue } = require('../../src/shared/session-run-state.cjs');
const { attentionFor, badgeCounts, emptyStore } = require('../../src/renderer/stage/unseen-completions.cjs');
const { planTaskbarBadge } = require('../../src/renderer/stage/taskbar-badge.cjs');

test('terminal dialog evidence blocks its session and clears without changing another session', () => {
  const store = createDialogStore();
  const session = { id: 'one', isLive: true };
  store.set('one', true);
  store.set('two', true);
  const snapshot = store.getSnapshot();
  store.set('one', true);
  assert.equal(snapshot, store.getSnapshot());
  assert.equal(runStateCue(session, null, { blocked: snapshot.has(session.id) }).kind, 'blocked');
  const descriptor = { ...session, open: true, blocked: snapshot.has(session.id) };
  assert.equal(attentionFor(descriptor, emptyStore()), 'blocked');
  assert.equal(planTaskbarBadge(badgeCounts([descriptor], emptyStore())).kind, 'amber');
  // Selection suppresses the rail pip, but an unanswered selected tile still
  // needs the amber taskbar badge when the user is in another application.
  descriptor.isSelected = true;
  assert.equal(attentionFor(descriptor, emptyStore()), null);
  assert.equal(planTaskbarBadge(badgeCounts([descriptor], emptyStore())).kind, 'amber');
  store.set('one', false);
  assert.equal(store.getSnapshot().has('two'), true);
  assert.notEqual(runStateCue(session, null, { blocked: store.getSnapshot().has(session.id) }).kind, 'blocked');
});

// 2026-10-14: a guard permission prompt ("Cloud secret mutation. Confirm the
// app and the secret name.") sat 24 minutes under a BLUE badge, because the
// card only published model-switch dialogs. Every dialog the card shows is a
// session waiting on you, and these are parsed by the real menu parser from
// the measured CLI layouts, so a parser change that stops a prompt from
// counting shows up here.
test('every permission prompt the card shows counts as waiting, the guard ask first', () => {
  for (const kind of ['guard', 'bash', 'outside', 'compound', 'edit', 'write', 'mcp', 'fetch', 'plan']) {
    const menu = parseMenu(fixture(kind));
    assert.ok(menu, `${kind}: the parser reads the prompt`);
    assert.ok(liveDialog(menu), `${kind}: a shown prompt is a session waiting on you`);
  }
});

test('the model switch and the unrecognized-prompt panel count; no dialog does not', () => {
  assert.ok(liveDialog({ kind: 'model-switch' }));
  assert.ok(liveDialog({ fallback: true, screen: ['Something new', ' Enter to confirm'] }));
  assert.equal(liveDialog(null), null);
  assert.equal(liveDialog({ options: [] }), null, 'a parse with no options is nothing to answer');
});

test('the badge goes amber for a session whose only evidence is a shown prompt', () => {
  // The descriptor the App builds: no hook-lane ask, a transcript header
  // with no blocked flag (the reader never sets one), and the card's verdict.
  const store = createDialogStore();
  store.set('mahjong', Boolean(liveDialog(parseMenu(fixture('guard')))));
  const header = { working: true };
  const descriptor = {
    id: 'mahjong',
    open: true,
    working: Boolean(header.working),
    blocked: store.getSnapshot().has('mahjong') || Boolean(header.blocked),
  };
  const finished = { id: 'other', open: true, isHistorical: true, activeMs: 2000 };
  const seen = { ...emptyStore(), seededAtMs: 1000 };
  const plan = planTaskbarBadge(badgeCounts([descriptor, finished], seen));
  assert.equal(plan.kind, 'amber');
  assert.equal(plan.label, '1');
  // Answered: the card clears, the session is working again, the badge falls back to blue.
  store.set('mahjong', false);
  const after = { ...descriptor, blocked: store.getSnapshot().has('mahjong') };
  assert.equal(planTaskbarBadge(badgeCounts([after, finished], seen)).kind, 'accent');
});
