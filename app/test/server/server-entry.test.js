'use strict';

// The harbor-server entry point (2026-10-21 audit). Two rules live there and
// nowhere else, because tests compose the server without it: every log line is
// timestamped, and a failed boot ends the process so run-server.cmd respawns
// it, even when providers started before the failure keep handles alive.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { stampConsole } = require('../../src/server/index.js');

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;

function fakeConsole() {
  const lines = [];
  const sink = (name) => (text) => lines.push({ name, text });
  return { lines, target: { log: sink('log'), info: sink('info'), warn: sink('warn'), error: sink('error') } };
}

test('every console method writes behind an ISO timestamp, formatted as console would', () => {
  const { lines, target } = fakeConsole();
  stampConsole(target, () => new Date('2026-10-21T13:22:05.123Z'));
  target.log('harbor-server listening on %s:%d', '127.0.0.1', 8787);
  target.info('plain');
  target.warn('harbor-server: sidebar error (continuing):', 'list request timed out');
  target.error(new Error('invalid token file'));
  assert.deepEqual(lines.map((l) => l.name), ['log', 'info', 'warn', 'error'], 'each still reaches its own stream');
  for (const { text } of lines) assert.match(text, ISO);
  assert.equal(lines[0].text, '2026-10-21T13:22:05.123Z harbor-server listening on 127.0.0.1:8787');
  assert.equal(lines[2].text, '2026-10-21T13:22:05.123Z harbor-server: sidebar error (continuing): list request timed out');
  assert.match(lines[3].text, /Error: invalid token file\n\s+at /, 'an Error keeps its stack');
});

test('stamping twice never stamps a line twice', () => {
  const { lines, target } = fakeConsole();
  stampConsole(target);
  stampConsole(target);
  target.log('once');
  assert.equal(lines[0].text.match(/\dZ /g).length, 1);
});

// The audit's reproduction: the real composition threw on an invalid token
// file after its watchers had started, and the process was still alive, not
// listening, when its parent gave up on it. Here a live interval stands in for
// those watchers, in a child, so the exit is observed for real.
test('a startup failure exits 1 even while started providers hold the process open', () => {
  const entry = JSON.stringify(require.resolve('../../src/server/index.js'));
  const script = `
    const { startFromCli } = require(${entry});
    startFromCli({
      graceMs: 200,
      run: async () => { setInterval(() => {}, 1000); throw new Error('invalid token file'); },
    });
  `;
  const started = Date.now();
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.error, undefined, `the child never exited: ${child.error?.code}`);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /startup failed.*\n?.*invalid token file/s);
  assert.ok(Date.now() - started < 8000);
});

test('a startup failure with nothing left alive exits 1 at once, without waiting out the grace', () => {
  const entry = JSON.stringify(require.resolve('../../src/server/index.js'));
  const script = `
    const { startFromCli } = require(${entry});
    startFromCli({ graceMs: 60_000, run: async () => { throw new Error('daemon did not become available'); } });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  assert.equal(child.error, undefined, 'an unref\'d grace timer must not hold an otherwise idle process');
  assert.equal(child.status, 1);
});
