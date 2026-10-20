'use strict';

// Every child process Harbor starts from its own code must say `windowsHide: true`.
//
// On Windows a console program started by a program that has no console of its own (the Electron main
// process, or a detached daemon) gets a fresh VISIBLE console window unless it is told not to. That was
// the recurring "little node box" on Pat's screen, and a launcher-by-launcher hunt never ended because the
// next new spawn site brought it back. This is a source scan, not a runtime check: it fails the moment
// someone adds a spawn, execFile or exec call that does not carry the flag.
//
// Calls that can only run on Linux or macOS are exempt by command name or by module, because there
// windowsHide means nothing. Add to those lists only for something that truly cannot run on win32.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');

const POSIX_ONLY_MODULES = new Set([
  'main/focus-guard.js',       // X11 focus guard, a no-op without X
  'main/login-path.js',        // login-shell PATH capture, macOS and Linux
  'main/platform/linux.js',
  'main/platform/darwin.js',
  'daemon/session-scope.js',   // systemd scopes, honestly "not linux" here
]);
const POSIX_ONLY_COMMANDS = new Set([
  'systemctl', 'systemd-run', 'xprop', 'wmctrl', 'xdotool', 'launchctl', '/usr/bin/security', '/usr/bin/which', 'sh',
]);

const CALL = /(?<![.\w$])(?<!function\s)(spawn|spawnSync|execFile|execFileSync|execFileImpl|exec|execSync|fork)\s*\(/g;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(c|m)?js$/.test(entry.name)) yield full;
  }
}

// Blank out comments but keep every newline, so reported line numbers stay true.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

function callText(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function findUnhiddenSpawns() {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (POSIX_ONLY_MODULES.has(rel)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    if (!/child_process|execFileImpl/.test(raw)) continue;
    const source = stripComments(raw);
    CALL.lastIndex = 0;
    let match;
    while ((match = CALL.exec(source))) {
      const open = source.indexOf('(', match.index + match[1].length);
      const text = callText(source, open);
      const first = /^\(\s*(['"`])([^'"`]+)\1/.exec(text);
      if (first && POSIX_ONLY_COMMANDS.has(first[2])) continue;
      if (/windowsHide/.test(text)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${rel}:${line}  ${match[1]}${text.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  return offenders;
}

test('every Windows-reachable child process in Harbor passes windowsHide', () => {
  const offenders = findUnhiddenSpawns();
  assert.deepEqual(offenders, [], `child process calls without windowsHide (a visible console window on Windows):\n${offenders.join('\n')}`);
});

test('the scan can fail: a spawn without windowsHide is reported', () => {
  const sample = "const { spawn } = require('node:child_process');\nspawn('node', ['x.js'], { stdio: 'ignore' });\n";
  const source = stripComments(sample);
  CALL.lastIndex = 0;
  const match = CALL.exec(source);
  assert.ok(match, 'the pattern finds the call');
  const text = callText(source, source.indexOf('(', match.index + match[1].length));
  assert.equal(/windowsHide/.test(text), false);
});
