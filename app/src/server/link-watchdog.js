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

const LINK_ERROR = /timed out|connection closed|ECONNRESET|EPIPE|not connected|socket/i;

function createLinkWatchdog({
  ping, // () => Promise, a FRESH control client's ping; rejects when the daemon is unreachable
  exit, // (code) => void
  log = () => {},
  windowMs = 120_000,
  errorsToTrip = 4,
  now = () => Date.now(),
} = {}) {
  if (typeof ping !== 'function' || typeof exit !== 'function') throw new TypeError('createLinkWatchdog requires ping and exit');
  let errors = [];
  let checking = false;
  let tripped = false;

  async function check() {
    if (checking || tripped) return;
    const cutoff = now() - windowMs;
    errors = errors.filter((t) => t >= cutoff);
    if (errors.length < errorsToTrip) return;
    checking = true;
    try {
      await ping();
    } catch (error) {
      log(`link watchdog: ${errors.length} link errors in ${Math.round(windowMs / 1000)} s, but the daemon itself is unreachable (${error.message}); staying up`);
      errors = [];
      return;
    } finally {
      checking = false;
    }
    tripped = true;
    log(`link watchdog: ${errors.length} link errors in ${Math.round(windowMs / 1000)} s while the daemon answers a fresh ping; exiting so run-server.cmd starts a clean server`);
    exit(75);
  }

  return {
    // Feed every subsystem error here; only link-shaped ones count.
    note(source, error) {
      const message = String(error?.message || error || '');
      if (!LINK_ERROR.test(message)) return;
      errors.push(now());
      check().catch(() => {});
    },
    check,
    get pending() { return errors.length; },
  };
}

module.exports = { createLinkWatchdog };
