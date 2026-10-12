'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { createHistoryIndex, parseTranscript } = require('../../src/main/providers/history-index.js');
const { parseEmitTsv } = require('../../src/main/providers/history.js');

test('a 2000-entry v2 cache opens without transcript reads and migrates only bounded heads afterward', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-migration-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsDir = path.join(root, 'projects'); const dir = path.join(projectsDir, 'sample'); const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cacheDir);
  const files = {};
  for (let i = 0; i < 2000; i++) {
    const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`; const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: 'C:\\synthetic\\project', timestamp: '2026-10-11T12:00:00Z', entrypoint: 'sdk-cli', message: { content: 'Synthetic prompt' } }) + '\n');
    const stat = fs.statSync(file); files[file] = { id, cwd: 'C:\\synthetic\\project', title: 'Cached title', first_prompt: 'Synthetic prompt', mt: stat.mtimeMs / 1000, sz: stat.size };
  }
  fs.writeFileSync(path.join(cacheDir, 'index.json'), JSON.stringify({ v: 2, files }));
  const index = createHistoryIndex({ projectsDir, cacheDir, profiles: [] });
  const originalOpen = fs.openSync; let reads = 0;
  fs.openSync = (file, ...args) => { if (String(file).endsWith('.jsonl')) reads++; return originalOpen(file, ...args); };
  try {
    const started = performance.now(); const first = index.refreshIndex(); const ms = performance.now() - started;
    const wire = index.run(['emit', '--all', '--with-first-prompt', '--with-cwd', '--with-path', '--with-entrypoint', '--with-meta']);
    console.log(JSON.stringify({ migrationFirstRefreshMs: ms, transcriptOpens: reads, entries: Object.keys(first).length, historyWireBytes: Buffer.byteLength(wire) }));
    assert.equal(Object.keys(first).length, 2000); assert.equal(reads, 0, 'window-gating refresh trusts v2 entries');
    assert.equal(first[Object.keys(files)[0]].title, 'Cached title');
    const batch = index.migrateEntries(8); assert.equal(batch.changed, 8); assert.equal(batch.remaining, 1992);
    assert.equal(reads, 8, 'migration reads one head per selected entry, without title/tail parsing');
    while (index.migrateEntries(128).remaining) {}
    const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json')));
    assert.equal(saved.v, 2, 'an old phone writer can still read this additive cache');
    assert.ok(Object.values(saved.files).every((entry) => entry.entrypoint === 'sdk-cli'));
  } finally { fs.openSync = originalOpen; }
});

test('missing entrypoint stops at ordinary head completeness and compact metadata has no JSON duplicates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-head-stop-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'projects', 'sample'); fs.mkdirSync(dir, { recursive: true });
  const id = '10000000-0000-4000-8000-000000000001'; const file = path.join(dir, id + '.jsonl');
  const prompt = 'Synthetic detailed request\twith a newline\nand literal \\n '.repeat(20);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: 'C:\\synthetic\\project', timestamp: '2026-10-11T12:00:00Z', message: { content: prompt } }) + '\n' + JSON.stringify({ type: 'system', entrypoint: 'sdk-cli' }) + '\n');
  assert.equal(parseTranscript(file).entrypoint, null, 'do not extend the head read just to discover an entrypoint');
});
