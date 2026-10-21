'use strict';

// harbor-server's own daemon-link watchdog.
//
// The desktop has main/daemon-watchdog.js for a wedged DAEMON. The phone
// server's recurring failure is different: the daemon stays healthy while the
// server's OWN long-lived links to it go stale. Its log then shows minutes of
// `sidebar error (continuing): list request timed out after 10000ms` and
// `session daemon connection closed` (2026-09-02 and again before the
// 2026-10-10 restart), every phone socket drops, and nothing heals, because
// run-server.cmd only respawns node when the process EXITS.
//
// The rule: count link errors from the subsystems that hold daemon links
// (sidebar, terminal-bridge). When enough land inside the window AND a FRESH
// control client can still ping the daemon, the daemon is fine and our links
// are the broken part: exit, so the respawn loop starts a clean server about
// three seconds later. When the fresh ping fails too, the daemon itself is down
// (Harbor closed, or restarting); exiting would only park the respawned server
// in waitForDaemon with Notes and Tasks dark, so it stays up and keeps serving
// what it can.
//
// IT COUNTS BURSTS, NOT ERRORS (2026-10-20). It used to trip on 4 link errors,
// and ONE slow daemon moment produces that many by itself: the client's
// request timeout destroys its socket, which rejects every other request in
// flight with "connection closed" in the same millisecond, and the client
// reconnects on its own at the next request, so nothing was stale. On a day
// the live daemon stalled 5 to 15 s at a time (sessiond.md, the state-file
// read bullet), each stall restarted this server, about every 3 minutes for
// hours (64 restarts logged), and every restart re-read about 3 GB at startup,
// load that fed the next stall. A real stale link fails on EVERY poll, so it
// still shows a new burst every ~10 s and trips in well under a minute; a
// single stall is one burst and never does.
//
// OUR OWN STALL IS NOT A BAD LINK (2026-10-21 audit). When this process's event
// loop blocks (an 18.5 s regex over a pasted image was measured), every daemon
// request's 10 s deadline expires inside the stall and fires the moment the
// loop resumes, before the poll phase can read the answer that is already
// waiting: a perfectly healthy daemon "times out" from here. Errors that land
// while, or within a few seconds after, the loop lagged past the request
// timeout are therefore not evidence and never count; a real stale link keeps
// failing between stalls and still trips.

const LINK_ERROR = /timed out|connection closed|ECONNRESET|EPIPE|not connected|socket/i;

// Measures this process's own event-loop lag: a 1 s interval that should fire
// every second, and whatever it fires late by is time the loop spent blocked.
// unref'd, so it never holds the process open. `worstSince` also counts a
// stall still being caught up on (no tick since it ended), because the
// deadline timers it expired run in the same timers phase, maybe ahead of this.
function createLoopLagMonitor({
  intervalMs = 1000,
  reportMs = 1000,
  log = () => {},
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let lastTick = now();
  let recent = []; // { at, ms } of the last few lags over reportMs, stamped when observed
  const tick = () => {
    const at = now();
    const drift = at - lastTick - intervalMs;
    lastTick = at;
    if (drift > reportMs) {
      recent = [...recent.slice(-7), { at, ms: drift }];
      log(`event loop lag observed: ${Math.round(drift)}ms`);
    }
  };
  const timer = setIntervalFn(tick, intervalMs);
  timer?.unref?.();
  return {
    tick,
    // The longest stall observed at or after `sinceMs`, or still in progress.
    worstSince(sinceMs) {
      const pending = now() - lastTick - intervalMs;
      let worst = pending > reportMs ? pending : 0;
      for (const lag of recent) if (lag.at >= sinceMs && lag.ms > worst) worst = lag.ms;
      return worst;
    },
    close() { clearIntervalFn(timer); },
  };
}

function createLinkWatchdog({
  ping, // () => Promise, a FRESH control client's ping; rejects when the daemon is unreachable
  exit, // (code) => void
  log = () => {},
  windowMs = 120_000,
  burstsToTrip = 4,
  // A link error more than this long after the previous one starts a new burst.
  burstGapMs = 5_000,
  now = () => Date.now(),
  // { worstSince(ms) => lagMs }, normally createLoopLagMonitor. Absent means
  // the rule above is off and every link error counts, as before.
  loopLag = null,
  // A request does not need a stall as long as its whole timeout to miss it: one
  // already 8 s into its 10 s budget misses on a 2 s stall (second Sol review,
  // which tripped the first rule with four 8 s stalls). So any stall of at
  // least lagExcludeMs inside a request's lifetime (the sessiond client's 10 s
  // timeout plus a grace for the expired timers to fire, lagGraceMs) excuses
  // the error. A link that is really broken also fails between stalls, and
  // those failures still count.
  lagExcludeMs = 2_000,
  lagGraceMs = 15_000,
} = {}) {
  if (typeof ping !== 'function' || typeof exit !== 'function') throw new TypeError('createLinkWatchdog requires ping and exit');
  let bursts = []; // start time of each burst
  let lastErrorAt = null;
  let checking = false;
  let tripped = false;
  let excused = 0;
  let lastExcusedAt = null;

  // True when this error is our own stall's echo, not the link's fault. Said
  // once per stall, so a stall that fails ten requests is one line.
  function causedByOwnLag(at, source) {
    const lagMs = loopLag?.worstSince?.(at - lagGraceMs) || 0;
    if (lagMs < lagExcludeMs) return false;
    excused += 1;
    if (lastExcusedAt === null || at - lastExcusedAt > lagGraceMs) {
      log(`link watchdog: ${source} link error landed right after this server's own ${Math.round(lagMs)}ms event-loop stall; not counted against the link`);
    }
    lastExcusedAt = at;
    return true;
  }

  async function check() {
    if (checking || tripped) return;
    const cutoff = now() - windowMs;
    bursts = bursts.filter((t) => t >= cutoff);
    if (bursts.length < burstsToTrip) return;
    checking = true;
    try {
      await ping();
    } catch (error) {
      log(`link watchdog: ${bursts.length} link-error bursts in ${Math.round(windowMs / 1000)} s, but the daemon itself is unreachable (${error.message}); staying up`);
      bursts = [];
      return;
    } finally {
      checking = false;
    }
    tripped = true;
    log(`link watchdog: ${bursts.length} separate link-error bursts in ${Math.round(windowMs / 1000)} s while the daemon answers a fresh ping; exiting so run-server.cmd starts a clean server`);
    exit(75);
  }

  return {
    // Feed every subsystem error here; only link-shaped ones count.
    note(source, error) {
      const message = String(error?.message || error || '');
      if (!LINK_ERROR.test(message)) return;
      const at = now();
      if (causedByOwnLag(at, source)) return;
      if (lastErrorAt === null || at - lastErrorAt > burstGapMs) bursts.push(at);
      lastErrorAt = at;
      check().catch(() => {});
    },
    check,
    get pending() { return bursts.length; },
    get excused() { return excused; },
  };
}

module.exports = { createLinkWatchdog, createLoopLagMonitor };
