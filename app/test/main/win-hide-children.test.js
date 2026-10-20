'use strict';

// The daemon-side guard that stops console windows from drawing on the desktop (src/daemon/win-hide-children.js).
// The proof that it works on a real ConPTY kill() was a private-desktop reproduction (a detached node calling
// terminal.kill(): the helper console became visible 22 ms after creation without the guard, never with it);
// these tests pin the pieces that proof depends on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const { install, withHide } = require('../../src/daemon/win-hide-children.js');

const DAEMON = path.join(__dirname, '..', '..', 'src', 'daemon');

function fakeChildProcess() {
  const calls = [];
  const target = {};
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    target[name] = function fake() { calls.push({ name, args: Array.prototype.slice.call(arguments) }); return name; };
  }
  target.execFile[promisify.custom] = function fakePromisified() {
    calls.push({ name: 'execFile.promisified', args: Array.prototype.slice.call(arguments) });
    return Promise.resolve({ stdout: 'out', stderr: '' });
  };
  return { target, calls };
}

test('withHide adds windowsHide to the options wherever they are', () => {
  assert.deepEqual(withHide(['node']), ['node', { windowsHide: true }]);
  assert.deepEqual(withHide(['node', ['a.js']]), ['node', ['a.js'], { windowsHide: true }]);
  assert.deepEqual(withHide(['node', ['a.js'], { cwd: 'C:/x' }]), ['node', ['a.js'], { cwd: 'C:/x', windowsHide: true }]);
  assert.deepEqual(withHide(['git', { cwd: 'C:/x' }]), ['git', { cwd: 'C:/x', windowsHide: true }]);
  const cb = () => {};
  assert.deepEqual(withHide(['git', ['log'], cb]), ['git', ['log'], { windowsHide: true }, cb]);
  assert.deepEqual(withHide(['git', cb]), ['git', { windowsHide: true }, cb]);
  assert.deepEqual(withHide(['git', ['log'], { timeout: 5 }, cb]), ['git', ['log'], { timeout: 5, windowsHide: true }, cb]);
  assert.deepEqual(withHide(['mod.js', undefined, { silent: true }]), ['mod.js', undefined, { silent: true, windowsHide: true }]);
});

test('withHide never changes the caller options object and honours an explicit choice', () => {
  const options = { cwd: 'C:/x' };
  const out = withHide(['node', [], options]);
  assert.equal(options.windowsHide, undefined);
  assert.notEqual(out[2], options);
  assert.equal(withHide(['node', [], { windowsHide: false }])[2].windowsHide, false);
  assert.equal(withHide(['node', [], { windowsHide: true }])[2].windowsHide, true);
});

test('install wraps every spawn function on win32 and calls the originals with the flag', () => {
  const { target, calls } = fakeChildProcess();
  assert.equal(install({ platform: 'win32', target }), true);
  target.fork('C:/agent.js', ['123']);
  target.spawn('node', ['x.js'], { stdio: 'ignore' });
  target.execFileSync('where.exe', ['node']);
  assert.deepEqual(calls.map((c) => c.name), ['fork', 'spawn', 'execFileSync']);
  for (const call of calls) assert.equal(call.args.find((a) => a && typeof a === 'object' && !Array.isArray(a)).windowsHide, true, call.name);
  assert.equal(calls[1].args[2].stdio, 'ignore', 'other options survive');
});

test('install keeps util.promisify working on execFile and exec', async () => {
  const { target, calls } = fakeChildProcess();
  install({ platform: 'win32', target });
  const result = await promisify(target.execFile)('git', ['--version']);
  assert.deepEqual(result, { stdout: 'out', stderr: '' }, 'still resolves the { stdout, stderr } shape');
  const last = calls.at(-1);
  assert.equal(last.name, 'execFile.promisified');
  assert.equal(last.args[2].windowsHide, true);
});

test('install is a no-op off win32 and only runs once', () => {
  const posix = fakeChildProcess();
  const originals = { ...posix.target };
  assert.equal(install({ platform: 'linux', target: posix.target }), false);
  assert.equal(posix.target.spawn, originals.spawn);

  const win = fakeChildProcess();
  assert.equal(install({ platform: 'win32', target: win.target }), true);
  const wrapped = win.target.spawn;
  assert.equal(install({ platform: 'win32', target: win.target }), false, 'second call does nothing');
  assert.equal(win.target.spawn, wrapped, 'not wrapped twice');
});

test('each daemon entry installs the guard before it loads child_process or node-pty', () => {
  for (const file of ['keeper.js', 'daemon.js', 'daemon-watch.js']) {
    const source = fs.readFileSync(path.join(DAEMON, file), 'utf8');
    const guard = source.indexOf("require('./win-hide-children.js').install()");
    assert.ok(guard > 0, `${file} installs the guard`);
    for (const later of ["require('node:child_process')", "require('node-pty')"]) {
      const at = source.indexOf(later);
      if (at !== -1) assert.ok(guard < at, `${file}: the guard comes before ${later}`);
    }
  }
});
