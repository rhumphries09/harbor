'use strict';

// The phone's view of the rail: only what its drawer can show.
//
// Pat, 2026-10-11: "if i leave the app for like 5 seconds and return to it
// (without closing the app) it reloads and takes a while." Measured on the live
// server that night: every phone (re)connect fetched the WHOLE rail model,
// 3.96 MB covering 4,368 sessions of history, received the same 3.96 MB again
// as a push right after, and re-fetched it every 15 s, while the drawer's
// default window shows the last 48 hours (a few dozen rows). On a phone that is
// a cold download, parse and render of all history on every return.
//
// So the server projects: live sessions, sessions waiting on an answer, and
// sessions inside the window the phone asked for (48 h by default; the drawer's
// Today/7d/30d/All choices ask for theirs), plus search across ALL history
// answered on demand and capped. Projects keep their shape and order, so the
// phone's grouping code runs unchanged on the smaller model.
//
// It also stamps each LIVE row with the context percentage Claude reported in
// its statusline tee (<contextDir>/<sessionId>.json, `used_percentage`), the
// same L1 ground truth the conversation header uses. Never a guess: no tee, no
// number.

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 2;
const SEARCH_LIMIT = 300;

function rowMs(session) {
  if (Number.isFinite(session?.lastActiveMs)) return session.lastActiveMs;
  const parsed = Date.parse(session?.lastActive || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function alwaysShown(session) {
  return Boolean(session?.isLive || session?.needsAnswer || session?.blocked);
}

// The same fields the phone's own filter matched (title and project), plus the
// first prompt and folder, because a search is the only way to reach an old
// session now that history no longer rides the push.
function matches(session, project, needle) {
  const hay = [
    session.childTitle, session.title, session.firstPrompt, session.project,
    project?.label, session.cwd, session.model, session.id,
  ].filter(Boolean).join('\n').toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

function normalizeDays(days) {
  if (days === 'all') return 'all';
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : DEFAULT_DAYS;
}

function projectRail(state, request = {}, { now = Date.now(), contextPct = null } = {}) {
  const model = state?.model && typeof state.model === 'object' && !Array.isArray(state.model) ? state.model : { projects: [] };
  const sourceProjects = Array.isArray(model.projects) ? model.projects : [];
  const query = String(request?.query || '').trim().toLowerCase();
  const days = normalizeDays(request?.days);
  const cutoff = days === 'all' ? -Infinity : now - days * DAY_MS;
  const limit = Math.max(1, Math.min(Number(request?.limit) || SEARCH_LIMIT, 1000));
  let totalRows = 0;
  let candidates = [];
  for (let p = 0; p < sourceProjects.length; p += 1) {
    const project = sourceProjects[p];
    for (const session of project?.sessions || []) {
      totalRows += 1;
      const keep = query ? matches(session, project, query) : (alwaysShown(session) || rowMs(session) >= cutoff);
      if (keep) candidates.push({ p, session });
    }
  }
  let truncated = false;
  if (candidates.length > limit && (query || days === 'all')) {
    // Newest first across projects, but a live or waiting row is never the one cut.
    const ranked = [...candidates].sort((a, b) => Number(alwaysShown(b.session)) - Number(alwaysShown(a.session)) || rowMs(b.session) - rowMs(a.session));
    const kept = new Set(ranked.slice(0, limit).map((c) => c.session));
    candidates = candidates.filter((c) => kept.has(c.session));
    truncated = true;
  }
  const byProject = new Map();
  for (const { p, session } of candidates) {
    const stamped = session.isLive && contextPct ? withContext(session, contextPct) : session;
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p).push(stamped);
  }
  const projects = [];
  for (let p = 0; p < sourceProjects.length; p += 1) {
    const sessions = byProject.get(p);
    if (sessions) projects.push({ ...sourceProjects[p], sessions, sessionCount: sessions.length });
  }
  return {
    ...state,
    model: { ...model, projects },
    phone: { days, query: query || null, totalRows, shownRows: candidates.length, truncated },
  };
}

function withContext(session, contextPct) {
  const pct = contextPct(session.id);
  return Number.isFinite(pct) ? { ...session, contextPct: pct } : session;
}

// Reads the statusline tee for one session. Small JSON files, a handful of
// live sessions per projection, cached for a few seconds so a burst of pushes
// does not re-read them.
function createContextReader(contextDir, { ttlMs = 5000, now = () => Date.now() } = {}) {
  const cache = new Map();
  return (sessionId) => {
    if (!contextDir || !sessionId || /[\\/]/.test(sessionId)) return null;
    const hit = cache.get(sessionId);
    if (hit && now() - hit.at < ttlMs) return hit.pct;
    let pct = null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(contextDir, `${sessionId}.json`), 'utf8'));
      const value = raw?.used_percentage ?? raw?.context_window?.used_percentage;
      if (Number.isFinite(value)) pct = Math.max(0, Math.min(100, Math.round(value)));
    } catch { pct = null; }
    cache.set(sessionId, { pct, at: now() });
    return pct;
  };
}

module.exports = { projectRail, createContextReader, DEFAULT_DAYS, SEARCH_LIMIT };
