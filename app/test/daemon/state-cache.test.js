'use strict';
const { execPath: guiNodeExec, IS_WIN32 } = require('../support/gui-node.js');

// A SESSION RECORD IS READ WHEN IT CHANGES, NOT ON EVERY REQUEST (2026-10-20).
// The daemon re-read a state file for every keeper-bound request and every
// state file for every list; under antivirus latency those synchronous reads
// held its only thread for seconds at a time (header of state-cache.js).
// Pure rules first, against real files so the stamp is NTFS's own, then the
// real daemon, two-sided: 80 requests against an unchanged record must not
// read it 80 times (the pre-fix daemon reads it at least that often), and a
// record the keeper rewrites must still be seen at once.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createStateFileCache } = require('../../src/daemon/state-cache.js');
const { SessionClient } = require('../../src/daemon/client.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), prefix));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  return dir;
}

// The keepers' own write shape: temp file, then rename over the record.
function writeByRename(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  fs.renameSync(temporary, file);
}

function countingFs() {
  const counter = { reads: 0 };
  const fsImpl = {
    statSync: (...args) => fs.statSync(...args),
    readFileSync: (...args) => { counter.reads += 1; return fs.readFileSync(...args); },
  };
  return { fsImpl, counter };
}

test('an unchanged record is read once, and a renamed-in record is read at once', () => {
  const dir = tempDir('harbor-state-cache-');
  const file = path.join(dir, 'a.json');
  const { fsImpl, counter } = countingFs();
  const cache = createStateFileCache({ fsImpl });
  writeByRename(file, { id: 'a', cols: 120 });
  for (let i = 0; i < 100; i += 1) assert.equal(cache.readJson(file).cols, 120);
  assert.equal(counter.reads, 1, '100 lookups of an unchanged record read it once');
  // Same length on purpose: only the rename (a new file id) can tell them apart
  // when both writes land inside one clock tick.
  writeByRename(file, { id: 'a', cols: 121 });
  assert.equal(cache.readJson(file).cols, 121, 'the rewritten record is served on the very next call');
  assert.equal(counter.reads, 2);
  for (let i = 0; i < 20; i += 1) {
    writeByRename(file, { id: 'a', cols: 130 + (i % 2) });
    assert.equal(cache.readJson(file).cols, 130 + (i % 2), `rapid rewrite ${i} is never served stale`);
  }
});

test('a missing record throws, bad text is never kept, and callers get their own objects', () => {
  const dir = tempDir('harbor-state-cache-');
  const file = path.join(dir, 'b.json');
  const { fsImpl, counter } = countingFs();
  const cache = createStateFileCache({ fsImpl });
  assert.throws(() => cache.readJson(file), 'an absent record throws, as the uncached read did');
  fs.writeFileSync(file, '{"id": "b", "cols":');
  assert.throws(() => cache.readJson(file));
  assert.throws(() => cache.readJson(file));
  assert.equal(counter.reads, 2, 'text that does not parse is re-read, never served from the cache');
  writeByRename(file, { id: 'b', exit: null });
  const first = cache.readJson(file);
  first.exit = { code: 1 };
  assert.equal(cache.readJson(file).exit, null, 'mutating one result never leaks into the next');
});

test('retain and forget drop records that are gone', () => {
  const dir = tempDir('harbor-state-cache-');
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const cache = createStateFileCache();
  writeByRename(a, { id: 'a' });
  writeByRename(b, { id: 'b' });
  cache.readJson(a);
  cache.readJson(b);
  assert.equal(cache.size, 2);
  cache.retain([a]);
  assert.equal(cache.size, 1, 'a record missing from the listing is dropped');
  cache.forget(a);
  assert.equal(cache.size, 0);
  fs.rmSync(a);
  assert.throws(() => cache.readJson(a), 'a deleted record is not served from memory');
});

// Counts the DAEMON's reads of session records (keepers load the hook too and
// are ignored), one byte per read, into a file the test owns.
const READ_COUNTER_HOOK = `
if (/daemon\\.js$/.test(process.argv[1] || '')) {
  const fs = require('node:fs');
  const path = require('node:path');
  const original = fs.readFileSync;
  const counterFile = process.env.HARBOR_TEST_STATE_READS;
  fs.readFileSync = function countedReadFileSync(file, ...rest) {
    if (typeof file === 'string' && path.basename(path.dirname(file)) === 'sessions'
      && file.endsWith('.json') && !file.endsWith('.config.json')) {
      try { fs.appendFileSync(counterFile, '.'); } catch {}
    }
    return original.call(this, file, ...rest);
  };
}
`;

test('the real daemon serves 80 requests without re-reading an unchanged record, and sees a rewrite at once', { timeout: 120_000 }, async () => {
  const dir = tempDir('harbor-state-reads-');
  const socketPath = path.join(dir, 'daemon.sock');
  const hookPath = path.join(dir, 'count-reads.js');
  const counterFile = path.join(dir, 'reads.txt');
  fs.writeFileSync(hookPath, READ_COUNTER_HOOK);
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_TEST_STATE_READS: counterFile,
      NODE_OPTIONS: `--require ${JSON.stringify(hookPath)}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  // Registered BEFORE the readiness wait (sessiond.md porting rules).
  cleanups.push(async () => {
    const pids = [];
    try {
      for (const name of fs.readdirSync(path.join(dir, 'sessions'))) {
        if (!name.endsWith('.json') || name.endsWith('.config.json')) continue;
        try {
          const state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', name), 'utf8'));
          pids.push(state.keeper_pid, state.pid);
        } catch {}
      }
    } catch {}
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    for (const pid of pids.filter(Boolean)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await sleep(500);
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { if ((await client.request('health')).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }

  const argv = IS_WIN32
    ? [process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', '/d', '/k']
    : ['/bin/sh', '-c', 'sleep 600'];
  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const { id } = await client.request('spawn', { argv, cwd: dir, env: childEnv, cols: 80, rows: 24 });
  await sleep(1500);

  fs.writeFileSync(counterFile, '');
  for (let i = 0; i < 60; i += 1) {
    const screen = await client.request('screen', { id });
    assert.ok(screen && typeof screen === 'object', 'every screen request is answered');
  }
  for (let i = 0; i < 20; i += 1) {
    const listed = await client.request('list');
    assert.ok(listed.sessions.find((s) => s.id === id), 'the session stays listed');
  }
  const reads = fs.readFileSync(counterFile, 'utf8').length;
  assert.ok(reads <= 10, `80 requests against an unchanged record read it ${reads} times (the uncached daemon reads it at least 80 times)`);

  // The keeper rewrites its record on resize; the very next list must show it.
  await client.request('resize', { id, cols: 101, rows: 31 });
  const after = (await client.request('list')).sessions.find((s) => s.id === id);
  assert.equal(after.cols, 101, `a rewritten record is seen at once, got ${JSON.stringify(after)}`);
  assert.equal(after.rows, 31);
});
