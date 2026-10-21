'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createHistoryProvider,
  parseEmitTsv,
  parseTreeTsv,
} = require('../../src/main/providers/history.js');

test('parseEmitTsv returns structured sessions, trims projects, reads first prompt and cwd', () => {
  const rows = parseEmitTsv([
    '11111111-1111-1111-1111-111111111111\t2026-07-17 01:30\tproject-one\tFirst prompt\tthe full first prompt text\t/home/you/dev/project-one',
    '22222222-2222-2222-2222-222222222222\t2026-07-16 23:00\t~\tHome task\t\t',
  ].join('\n'));
  assert.deepEqual(rows, [
    { id: '11111111-1111-1111-1111-111111111111', lastActive: '2026-07-17 01:30', project: 'project-one', title: 'First prompt', firstPrompt: 'the full first prompt text', cwd: '/home/you/dev/project-one' },
    { id: '22222222-2222-2222-2222-222222222222', lastActive: '2026-07-16 23:00', project: '~', title: 'Home task', firstPrompt: null, cwd: null },
  ]);
});

test('listSessions passes indexer filters and applies case-insensitive query', async () => {
  const calls = [];
  const provider = createHistoryProvider({
    runIndexer: async (args) => {
      calls.push(args);
      return '1\t2026-07-17 01:30\talpha\tNeedle title\tNeedle prompt\t/tmp/alpha\n2\t2026-07-16 22:00\tbeta\tOther\t\t/tmp/beta';
    },
    watchFactory: () => ({ close() {} }),
  });
  const rows = await provider.listSessions({ since: '7d', project: 'alpha', query: 'needle' });
  assert.deepEqual(calls, [['emit', '--all', '--with-first-prompt', '--with-cwd', '--with-path', '--with-entrypoint', '--with-meta', '--since', '7d', '--project', 'alpha']]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '1');
});

test('parseTreeTsv preserves typed tree rows', () => {
  assert.deepEqual(parseTreeTsv('P:alpha\t▸ alpha  2 sessions\nF:-\t+ new session\n'), [
    { key: 'P:alpha', type: 'project', value: 'alpha', display: '▸ alpha  2 sessions' },
    { key: 'F:-', type: 'folder', value: '-', display: '+ new session' },
  ]);
});

test('sessionMeta parses JSON and sessionPreview returns indexer text', async () => {
  const provider = createHistoryProvider({
    runIndexer: async ([command]) => command === 'meta'
      ? '{"id":"abc","home":"team","cwd":"/tmp/project"}\n'
      : 'Preview body\n',
    watchFactory: () => ({ close() {} }),
  });
  assert.equal((await provider.sessionMeta('abc')).home, 'team');
  assert.equal(await provider.sessionPreview('abc'), 'Preview body\n');
});

test('history watcher emits once after a burst and can be closed', async () => {
  let watcher;
  const fakeWatcher = new EventEmitter();
  fakeWatcher.close = () => { fakeWatcher.closed = true; };
  const provider = createHistoryProvider({
    runIndexer: async () => '',
    debounceMs: 15,
    watchFactory: (_path, cb) => {
      watcher = fakeWatcher;
      fakeWatcher.on('change', cb);
      return fakeWatcher;
    },
  });
  let changes = 0;
  provider.on('history-changed', () => { changes += 1; });
  watcher.emit('change');
  watcher.emit('change');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(changes, 1);
  provider.close();
  assert.equal(fakeWatcher.closed, true);
});

// A TRAILING DEBOUNCE WITH A CEILING (2026-10-21 audit). Each write reset the
// 5 s timer, so a session writing about once a second froze the rail's history
// for as long as it worked: the audit drove 60 s of one-second writes through
// the real provider and got zero events. Two-sided: the busy stream refreshes
// on the ceiling, and a quiet one still settles once, after the debounce.
test('a stream of writes that never pauses still refreshes history within the ceiling', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  let onChange = null;
  const provider = createHistoryProvider({
    runIndexer: async () => '',
    watchFactory: (_path, cb) => { onChange = cb; return { close() {} }; },
    now: () => clock,
  });
  let changes = 0;
  provider.on('history-changed', () => { changes += 1; });
  const advance = (ms) => { clock += ms; t.mock.timers.tick(ms); };

  for (let i = 0; i < 60; i += 1) { onChange(); advance(1000); }
  assert.equal(changes, 2, 'a minute of one-second writes refreshes on the 30 s ceiling, twice');

  onChange();
  advance(4999);
  assert.equal(changes, 2, 'a lone write still waits out the trailing debounce');
  advance(1);
  assert.equal(changes, 3);
  advance(60_000);
  assert.equal(changes, 3, 'and settles once, not on a timer of its own');
  provider.close();
});
