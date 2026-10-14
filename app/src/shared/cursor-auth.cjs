'use strict';

// Where the Cursor CLI keeps its sign-in, and the environment every cursor-agent
// child needs so that sign-in survives the run.
//
// A Cursor User API key sign-in has to be RESUPPLIED on every run (2026-10-13,
// read in the 2026.10.12 bundle and measured on a copy): when auth.json holds an
// `apiKey` and a run passes none (no --api-key, no CURSOR_API_KEY), cursor-agent's
// login check DELETES auth.json, signing the CLI out. A run that does pass the key
// reuses the stored token while it is valid and trades the key for a new one-hour
// token when it is not. So every cursor child Harbor starts (panes, resumes, the
// model list, the updater) carries the stored key in its environment. A browser
// sign-in stores no key and is left exactly as it was.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function cursorAuthFile(home = os.homedir(), env = process.env, platform = process.platform) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  if (platform === 'darwin') return path.join(home, '.cursor', 'auth.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cursor', 'auth.json');
}

// The env to start cursor-agent with: `env` itself when it already names a key or
// no key is stored, else a copy with CURSOR_API_KEY set to the stored key. An
// empty CURSOR_API_KEY counts as none, because cursor-agent treats it as none.
function cursorAuthEnv(env = process.env, { home = os.homedir(), platform = process.platform, readFile = fs.readFileSync } = {}) {
  if (typeof env.CURSOR_API_KEY === 'string' && env.CURSOR_API_KEY) return env;
  let key = null;
  try {
    key = JSON.parse(readFile(cursorAuthFile(home, env, platform), 'utf8')).apiKey;
  } catch {
    return env;
  }
  return typeof key === 'string' && key ? { ...env, CURSOR_API_KEY: key } : env;
}

module.exports = { cursorAuthFile, cursorAuthEnv };
