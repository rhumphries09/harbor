'use strict';

// Words the Orch view uses for a run's shape (2026-10-12, Pat: "you need more
// shit running in parallel - not all of this needs to be sequential"). A
// pending batch used to read "no liveness signal" whether a dependency held it
// or it was ready and nobody had dispatched it, so an under-dispatched run
// looked exactly like a healthy one.

// Two names, then a count: a batch can wait on six others and the overview
// row's last column is not a paragraph. Callers put the full list in a title.
function waitingText(ids = []) {
  if (!ids || !ids.length) return 'waiting';
  const shown = ids.slice(0, 2).join(', ');
  return `waits on ${shown}${ids.length > 2 ? ` +${ids.length - 2} more` : ''}`;
}

// The run's shape in one line, from the per-worker states Harbor derives
// (refineSummary), never the raw queue status: a claimed batch stays `active`
// through review, so "3 running" over one working, one finished and one hung
// worker was the same healthy-looking lie this line exists to remove (Astra
// review, 2026-10-12). A summary without the derived counts falls back to
// saying "active", which is all the queue itself knows.
function runCounts(summary) {
  if (!summary) return null;
  const parts = [];
  const derived = ['working', 'awaitingReview', 'quiet', 'missing'].some((key) => typeof summary[key] === 'number');
  if (derived) {
    if (summary.working) parts.push(`${summary.working} working`);
    if (summary.awaitingReview) parts.push(`${summary.awaitingReview} awaiting review`);
    if (summary.quiet) parts.push(`${summary.quiet} quiet`);
    if (summary.missing) parts.push(`${summary.missing} with no signal`);
  } else if (summary.active) {
    parts.push(`${summary.active} active`);
  }
  if (summary.ready) parts.push(`${summary.ready} ready, not started`);
  if (summary.waiting) parts.push(`${summary.waiting} waiting on other batches`);
  return parts.length ? parts.join(' · ') : null;
}

function formatEta(ms) {
  if (!ms) return null;
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours}h${rest ? ` ${rest}m` : ''}`;
}

// The ETA charges a batch already past the average only a quarter of it, a
// guess; when any are, the text says so instead of promising the same few
// minutes on every refresh. It says "batches", not "running": an active batch
// past the usual length may be a worker that already finished and is waiting
// for review (Astra review, round 2).
function etaText(summary) {
  const eta = formatEta(summary?.etaMs);
  if (!eta) return null;
  const n = summary.overrunning;
  const long = n
    ? `, ${n} ${n === 1 ? 'batch is' : 'batches are'} past the usual length so likely later`
    : '';
  return `rough ETA ${eta}${long}`;
}

module.exports = { waitingText, runCounts, formatEta, etaText };
