// What the phone last showed, kept on the phone so a cold start paints at once.
//
// iOS can discard a backgrounded web app outright, and then a return to it is a
// full boot: before this, nothing was on screen until the socket connected and
// the whole session list and transcript arrived again (Pat, 2026-10-11: "it
// reloads and takes a while"). The last session list and the last few open
// conversations' recent blocks are kept here, painted on boot, and replaced the
// moment the server answers. Bounded on purpose: localStorage is a few MB per
// origin and a full write must never throw into a render.

const PREFIX = 'harbor-mobile-cache-v1:';
const TRANSCRIPT_INDEX = `${PREFIX}transcripts`;
const MAX_TRANSCRIPTS = 4;
const MAX_SIDEBAR_CHARS = 900_000;
const MAX_TRANSCRIPT_CHARS = 350_000;

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function read(key) {
  const s = storage();
  if (!s) return null;
  try { const raw = s.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function write(key, value, maxChars) {
  const s = storage();
  if (!s) return false;
  try {
    const raw = JSON.stringify(value);
    if (raw.length > maxChars) return false;
    s.setItem(key, raw);
    return true;
  } catch { return false; }
}

export function readCachedSidebar() {
  const hit = read(`${PREFIX}sidebar`);
  return hit?.model && Array.isArray(hit.model.projects) ? hit : null;
}

export function writeCachedSidebar(model) {
  if (!model || !Array.isArray(model.projects)) return false;
  return write(`${PREFIX}sidebar`, { model, at: Date.now() }, MAX_SIDEBAR_CHARS);
}

// The Tasks and Notes documents (2026-10-21 review): each view held its doc in
// component state, so leaving the tab dropped it and coming back offline showed
// "Loading…" over a list the phone had already read. The last doc is kept here
// (and in memory, so a tab switch costs no parse) and painted until the server
// answers; edits still go through the server's mutation contract.
const MAX_DOC_CHARS = 600_000;
const docMemory = new Map();

export function readCachedDoc(name) {
  if (docMemory.has(name)) return docMemory.get(name);
  const hit = read(`${PREFIX}doc:${name}`);
  const doc = hit?.doc && typeof hit.doc === 'object' ? hit.doc : null;
  if (doc) docMemory.set(name, doc);
  return doc;
}

export function writeCachedDoc(name, doc) {
  if (!doc || typeof doc !== 'object') return false;
  docMemory.set(name, doc);
  return write(`${PREFIX}doc:${name}`, { doc, at: Date.now() }, MAX_DOC_CHARS);
}

export function readCachedTranscript(sessionId) {
  if (!sessionId) return null;
  const hit = read(`${PREFIX}t:${sessionId}`);
  return hit && Array.isArray(hit.blocks) ? hit : null;
}

// Keeps the most recent blocks that fit; images are the usual reason a block
// list is large, so a list that does not fit is retried with fewer blocks
// before giving up.
export function writeCachedTranscript(sessionId, blocks, header) {
  if (!sessionId || !Array.isArray(blocks)) return false;
  let keep = Math.min(blocks.length, 60);
  let ok = false;
  while (keep > 0 && !ok) {
    ok = write(`${PREFIX}t:${sessionId}`, { blocks: blocks.slice(-keep), header: header || null, at: Date.now() }, MAX_TRANSCRIPT_CHARS);
    if (!ok) keep = Math.floor(keep / 2);
  }
  if (!ok) return false;
  const s = storage();
  const index = (read(TRANSCRIPT_INDEX) || []).filter((id) => id !== sessionId);
  index.unshift(sessionId);
  for (const evicted of index.splice(MAX_TRANSCRIPTS)) {
    try { s?.removeItem(`${PREFIX}t:${evicted}`); } catch { /* best effort */ }
  }
  write(TRANSCRIPT_INDEX, index, 10_000);
  return true;
}

// Writes are coalesced: pushes can land several times a second while a
// session works, and a synchronous localStorage write on each would cost the
// main thread for nothing.
export function createDebouncedWriter(fn, delayMs = 800) {
  let timer = null;
  let args = null;
  const flush = () => { timer = null; const a = args; args = null; if (a) fn(...a); };
  return {
    schedule(...next) { args = next; if (!timer) timer = setTimeout(flush, delayMs); },
    flush() { clearTimeout(timer); flush(); },
  };
}
