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

const LINK_ERROR = /timed out|connection closed|ECONNRESET|EPIPE|not connected|socket/i;

function createLinkWatchdog({
  ping, // () => Promise, a FRESH control client's ping; rejects when the daemon is unreachable
  exit, // (code) => void
  log = () => {},
  windowMs = 120_000,
  burstsToTrip = 4,
  // A link error more than this long after the previous one starts a new burst.
  burstGapMs = 5_000,
  now = () => Date.now(),
} = {}) {
  if (typeof ping !== 'function' || typeof exit !== 'function') throw new TypeError('createLinkWatchdog requires ping and exit');
  let bursts = []; // start time of each burst
  let lastErrorAt = null;
  let checking = false;
  let tripped = false;

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
      if (lastErrorAt === null || at - lastErrorAt > burstGapMs) bursts.push(at);
      lastErrorAt = at;
      check().catch(() => {});
    },
    check,
    get pending() { return bursts.length; },
  };
}

module.exports = { createLinkWatchdog };
