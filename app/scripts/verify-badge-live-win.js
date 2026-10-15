'use strict';

// PRODUCTION check for the yellow taskbar badge (2026-10-15: "ALL TESTING IS
// IN PROD"; the harness drive, scripts/drive-taskbar-badge-win.js, is not
// proof). It reads Pat's LIVE Harbor, read-only, through its main process's
// Node inspector (process._debugProcess opens it on 127.0.0.1:9229, the same
// method as the 2026-10-04 badge diagnosis).
//
//   --install            record every taskbar overlay set from now on (a
//                        pass-through wrapper; gone at the next restart)
//   --check [--since ISO] for every terminal-only prompt in the ask hook's log
//                        since then, say whether its session is an open window
//                        and whether an AMBER overlay was set within 10 s
//
// A terminal-only prompt is the hook's "step aside: unsupported prompt
// (PermissionRequest)" line: the CLI draws that dialog in the pane and only
// the window's answer card can see it (docs/claude/views.md, "A PROMPT DRAWN
// ONLY IN THE TERMINAL"). Prompts in sessions that are not open windows are
// listed but not judged: the badge counts open windows only, by design.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOOK_LOG = path.join(os.homedir(), '.harbor', 'asks', 'hook.log');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const LIFECYCLE = path.join(os.homedir(), '.cache', 'harbor', 'perf', 'lifecycle.jsonl');
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };

function harborMainPid() {
  const boots = fs.readFileSync(LIFECYCLE, 'utf8').trim().split('\n')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((r) => r && r.kind === 'boot' && /AppData[\\/]Roaming[\\/]harbor$/.test(r.userData || ''));
  const pid = boots.at(-1)?.pid;
  if (!pid) throw new Error('no Harbor boot record in lifecycle.jsonl');
  const alive = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CommandLine -notmatch '--type=') { 'yes' }`], { encoding: 'utf8', windowsHide: true }).trim();
  if (alive !== 'yes') throw new Error(`Harbor main pid ${pid} (last boot) is not running`);
  return pid;
}

async function evaluate(expression) {
  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    try { target = (await fetch('http://127.0.0.1:9229/json/list').then((r) => r.json()))[0]; } catch { await sleep(250); }
  }
  if (!target) throw new Error('no inspector on 127.0.0.1:9229');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const reply = new Promise((resolve) => ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) resolve(message);
  }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }));
  const message = await reply;
  ws.close();
  if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.exception?.description || 'evaluate failed');
  return message.result?.result?.value;
}

const WINDOW = `require('electron').BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /index\\.html/.test(w.webContents.getURL()))`;

// The session whose open tool call was made within 5 s of the prompt.
function sessionAt(atMs) {
  for (const dir of fs.readdirSync(PROJECTS)) {
    let names = [];
    try { names = fs.readdirSync(path.join(PROJECTS, dir)).filter((name) => name.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) {
      const file = path.join(PROJECTS, dir, name);
      const stat = fs.statSync(file);
      if (stat.mtimeMs < atMs - 5000) continue;
      const length = Math.min(stat.size, 4 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      fs.closeSync(fd);
      for (const line of buffer.toString('utf8').split('\n')) {
        let record; try { record = JSON.parse(line); } catch { continue; }
        const content = record.message?.content;
        if (!Array.isArray(content)) continue;
        const ts = Date.parse(record.timestamp);
        if (content.some((block) => block.type === 'tool_use') && Math.abs(ts - atMs) < 5000) return name.slice(0, 36);
      }
    }
  }
  return null;
}

async function main() {
  const pid = harborMainPid();
  process._debugProcess(pid);
  if (process.argv.includes('--install')) {
    const installed = await evaluate(`(() => {
      const win = ${WINDOW};
      if (globalThis.__badgeProbe) {
        globalThis.__badgeProbeSince = globalThis.__badgeProbeSince || Date.now();
        return 'already installed since ' + new Date(globalThis.__badgeProbeSince).toISOString();
      }
      globalThis.__badgeProbe = [];
      globalThis.__badgeProbeSince = Date.now();
      const original = win.setOverlayIcon.bind(win);
      win.setOverlayIcon = (image, description) => { globalThis.__badgeProbe.push({ t: Date.now(), image: Boolean(image), d: description }); return original(image, description); };
      return 'installed';
    })()`);
    console.log(`Harbor pid ${pid}: overlay recorder ${installed}`);
    return;
  }
  const probe = JSON.parse(await evaluate(`JSON.stringify({ since: globalThis.__badgeProbeSince || null, sets: globalThis.__badgeProbe || null })`));
  if (!probe.sets) throw new Error('no recorder in this Harbor: run --install first (a restart removes it)');
  const sinceMs = Math.max(Date.parse(arg('--since') || 0) || 0, probe.since);
  const prompts = fs.readFileSync(HOOK_LOG, 'utf8').split('\n')
    .filter((line) => line.includes('step aside: unsupported prompt (PermissionRequest)'))
    .map((line) => Date.parse(line.slice(0, 24)))
    .filter((ms) => ms >= sinceMs);
  console.log(`recorder since ${new Date(probe.since).toISOString()}; ${probe.sets.length} overlay set(s); ${prompts.length} terminal prompt(s) since ${new Date(sinceMs).toISOString()}`);
  for (const atMs of prompts) {
    const session = sessionAt(atMs);
    const open = session ? await evaluate(`${WINDOW}.webContents.executeJavaScript(${JSON.stringify(`Boolean(document.querySelector('.win2[data-session-id="${session}"]'))`)})`) : false;
    const sets = probe.sets.filter((set) => set.t >= atMs && set.t <= atMs + 10000);
    const amber = sets.some((set) => set.image && /^[1-9]\d* sessions? waiting/.test(String(set.d)));
    const verdict = !open ? 'not an open window (not judged)' : amber ? 'AMBER' : 'NOT AMBER';
    console.log(JSON.stringify({ at: new Date(atMs).toISOString(), session: session ? session.slice(0, 8) : null, verdict, sets }));
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
