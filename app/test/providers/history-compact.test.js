'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { createHistoryIndex, parseTranscript } = require('../../src/main/providers/history-index.js');
const { parseEmitTsv } = require('../../src/main/providers/history.js');

test('bulk metadata carries the prompt once without a per-row JSON object', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-compact-meta-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsDir = path.join(root, 'projects'); const dir = path.join(projectsDir, 'sample'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '10000000-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ type: 'user', cwd: 'C:\\synthetic\\project', timestamp: '2026-10-11T12:00:00Z', entrypoint: 'cli', message: { content: 'Synthetic request '.repeat(60) } }) + '\n');
  const index = createHistoryIndex({ projectsDir, cacheDir: path.join(root, 'cache'), profiles: [] });
  const wire = index.run(['emit', '--all', '--with-first-prompt', '--with-cwd', '--with-path', '--with-entrypoint', '--with-meta']);
  assert.equal(wire.includes('"firstPrompt"'), false, 'do not repeat existing columns in JSON metadata');
  assert.equal(wire.split('\t')[4].split('Synthetic request').length - 1, 60, 'the prompt column carries the complete prompt');
});
test('compact metadata preserves the full multiline metadata contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-head-stop-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'projects', 'sample'); fs.mkdirSync(dir, { recursive: true });
  const id = '10000000-0000-4000-8000-000000000001'; const file = path.join(dir, id + '.jsonl');
  const prompt = 'Synthetic detailed request\twith a newline\nand literal \\n '.repeat(20);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: 'C:\\synthetic\\project', timestamp: '2026-10-11T12:00:00Z', message: { content: prompt } }) + '\n' + JSON.stringify({ type: 'system', entrypoint: 'sdk-cli' }) + '\n');
  assert.equal(parseTranscript(file).entrypoint, null, 'do not extend the head read just to discover an entrypoint');
  const index = createHistoryIndex({ projectsDir: path.join(root, 'projects'), cacheDir: path.join(root, 'cache'), profiles: [] });
  const wire = index.run(['emit', '--all', '--with-first-prompt', '--with-cwd', '--with-path', '--with-entrypoint', '--with-meta']);
  assert.equal(wire.includes('"firstPrompt"'), false, 'no repeated JSON metadata object');
  const [row] = parseEmitTsv(wire); const { home, ...meta } = JSON.parse(index.run(['meta', id]));
  assert.deepEqual(row.meta, meta, 'compact columns still reconstruct the complete metadata contract');
  assert.equal([...row.firstPrompt].length, 300, 'rail search keeps its existing prompt bound');
  console.log(JSON.stringify({ compactHistoryBytes: Buffer.byteLength(wire) }));
});
