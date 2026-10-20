'use strict';

// Every child process the daemon side starts hides its console window on Windows, unless the caller
// says otherwise (2026-10-20, "i think node ... fairly frequently").
//
// WHY. The daemon, its watcher and every session keeper are detached node.exe processes, and a detached
// process has NO console. A console program such as node.exe, cmd.exe or git.exe started by a process with
// no console is handed a brand-new console, and Windows shows it. node-pty does exactly that on every
// ConPTY `kill()`: `child_process.fork(conpty_console_list_agent)` with no windowsHide, so each closed,
// dormant or reaped session drew a 912x517 "node" console that stayed visible about 20 ms to a few hundred
// ms and could pull focus out of a fullscreen game. Proven on a private desktop with
// ConsoleSentinel.exe --probe: a detached node that calls terminal.kill() creates that window; with this
// guard installed it does not. It is third-party code, so the fix is here and not in node_modules (a
// reinstall would wipe a patch there), and it also covers any later dependency that forgets the flag.
//
// HOW. install() wraps spawn, spawnSync, execFile, execFileSync, exec, execSync and fork so an options
// object without `windowsHide` gets `windowsHide: true` (a copy; the caller's object is never changed). An
// explicit `windowsHide: false` is honoured. It must run BEFORE anything destructures these functions
// from child_process, so it is the first statement of each daemon entry file. util.promisify keeps working
// because the wrapped functions carry the original's promisify.custom.
//
// Only these daemon processes install it: they start console programs only. Windows-only; a no-op elsewhere.

const childProcess = require('node:child_process');
const { promisify } = require('node:util');

const INSTALLED = Symbol.for('harbor.windowsHideDefault');
const NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

// The options object is the first plain object after the command; a callback means the options were left
// out and belong just before it; otherwise they go last.
function withHide(args) {
  const out = Array.prototype.slice.call(args);
  for (let i = 1; i < out.length; i += 1) {
    const arg = out[i];
    if (typeof arg === 'function') {
      out.splice(i, 0, { windowsHide: true });
      return out;
    }
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      if (arg.windowsHide === undefined) out[i] = Object.assign({}, arg, { windowsHide: true });
      return out;
    }
  }
  out.push({ windowsHide: true });
  return out;
}

function install({ platform = process.platform, target = childProcess } = {}) {
  if (platform !== 'win32') return false;
  if (target[INSTALLED]) return false;
  for (const name of NAMES) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    const patched = function patchedChildProcessCall() {
      return original.apply(this, withHide(arguments));
    };
    Object.defineProperty(patched, 'name', { value: original.name });
    const custom = original[promisify.custom];
    if (typeof custom === 'function') {
      Object.defineProperty(patched, promisify.custom, {
        value: function patchedPromisified() { return custom.apply(this, withHide(arguments)); },
      });
    }
    target[name] = patched;
  }
  Object.defineProperty(target, INSTALLED, { value: true });
  return true;
}

module.exports = { install, withHide };
