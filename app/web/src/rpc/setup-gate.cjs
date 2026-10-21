'use strict';

// Whether the phone has to be asked for a token, as a value, so the rule has a
// test instead of a screenshot.
//
// This is the decision that made the installed app ask for a 64-character hex
// token on EVERY cold launch. iOS gives a home-screen web app its own storage
// container, separate from Safari's, so `token` is empty on every launch no
// matter what was pasted into the browser, and the old gate
// (`!settings.token` -> show the setup screen) read that empty token as "never
// set up". There was no way to tell those two states apart on the client, which
// is why the answer has to come from the server.
//
// `auth` is the server's own answer from /whoami:
//   null/undefined  the answer has not arrived yet. HOLD. Guessing "required"
//                   flashes the very prompt this exists to remove, and guessing
//                   "not required" flashes the app for someone who is genuinely
//                   unauthenticated.
//   {authenticated} whether this caller is already authenticated by the tailnet,
//                   in which case no token exists to be asked for.
//   {unavailable}   the server could not be asked (offline, restarting, or no
//                   answer within the probe's deadline). That is not "a token
//                   is required", so it HOLDS and the probe is retried; reading
//                   it as required stranded a phone on the paste-a-token screen
//                   after a passing outage (2026-10-21 review, finding 3).
//   rememberedAuth  this phone was authenticated by the tailnet at this server
//                   before, so while the server cannot be asked it opens its
//                   saved list and conversations instead of a splash; the
//                   socket still has to authenticate to do anything.
function setupGate({ settings = {}, auth = null, rememberedAuth = false } = {}) {
  // A stored token needs nothing from the server to try its own connection, so
  // it never waits on /whoami (2026-10-21): the shell, its cached list and its
  // cached conversation paint at once and connect when they can.
  if (settings.serverUrl && settings.token) return 'ready';
  if (auth === null || auth === undefined) return settings.serverUrl && rememberedAuth ? 'ready' : 'pending';
  // No server URL means nothing to ask, which is the genuine first-run case on a
  // client that was not served BY the server it talks to.
  if (!settings.serverUrl) return 'setup';
  if (auth.unavailable) return rememberedAuth ? 'ready' : 'pending';
  return auth.authenticated ? 'ready' : 'setup';
}

module.exports = { setupGate };
