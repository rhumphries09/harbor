'use strict';

// A SESSION RECORD IS READ WHEN IT CHANGES, NOT ON EVERY REQUEST (2026-10-20,
// Pat: "computer is dragging ass ... that message has been sending for over a
// minute", after restarting Harbor five times that day just to get a send in).
//
// Every keeper-bound verb (screen, input, resize, process, terminate, annotate)
// opened and read its session's state file only to learn the keeper's pipe
// name, which never changes for the life of a session, and every `list` and
// `health` re-read every state file in the store. Harbor polls about 34 screen
// reads a second, so the daemon opened tiny JSON files dozens of times a
// second, synchronously, on its only thread. On this machine an open-for-read
// of a freshly written file pays the antivirus filter on every call: measured
// that afternoon at 2.1 ms average with spikes past 50 ms for a 700-byte file,
// while a stat of the same file took 0.07 ms with a 0.5 ms worst case (opening
// for attributes alone is not scanned). Under that day's load (Defender at one
// to two cores, heavy paging) single reads took 400 to 700 ms, and a 240 s CPU
// profile of the live daemon spent 74 s inside readFileUtf8: 56 s in
// keeperRequest's readState, 17.5 s in allStates. The event loop logged lag of
// 1 to 12 s dozens of times an hour (40 s at worst), the phone server's
// requests timed out into a restart loop, and Harbor's window showed a typed
// message "still starting up" because the pane's screen could not be read.
//
// So the cache keys each file's text on a stat stamp (mtime, size, file id)
// and re-reads only when the stamp moves. Keepers rewrite their record by
// atomic rename at most every 30 s of activity plus on resize and exit, and a
// rename always moves the stamp (the renamed-in file is a new file with its own
// id), so a changed record is never served stale: the next call after the
// rename reads it. The stat is BIGINT on purpose: an NTFS file id is 64 bits
// and a plain Number rounds ids above 2^53, so two temp files a few MFT records
// apart could share a stamp, and the mtime alone can repeat inside one clock
// tick. A missing file still throws (stat fails), exactly as the uncached read
// did. Every call parses afresh, so callers keep getting objects of their own
// to mutate. Text that does not parse is never kept.
function createStateFileCache({ fsImpl = require('node:fs') } = {}) {
  const entries = new Map(); // file -> { stamp, text }

  function stampOf(stat) {
    return `${stat.mtimeNs ?? stat.mtimeMs}:${stat.size}:${stat.ino}`;
  }

  function readJson(file) {
    const stamp = stampOf(fsImpl.statSync(file, { bigint: true }));
    const cached = entries.get(file);
    if (cached && cached.stamp === stamp) return JSON.parse(cached.text);
    const text = fsImpl.readFileSync(file, 'utf8');
    let value;
    try { value = JSON.parse(text); }
    catch (error) { entries.delete(file); throw error; }
    entries.set(file, { stamp, text });
    return value;
  }

  // Drops every entry whose file is not in `files` (the store's current
  // listing), so records reaped by anyone, or removed by hand, do not linger.
  function retain(files) {
    const keep = new Set(files);
    for (const file of entries.keys()) if (!keep.has(file)) entries.delete(file);
  }

  function forget(file) {
    entries.delete(file);
  }

  return { readJson, retain, forget, get size() { return entries.size; } };
}

module.exports = { createStateFileCache };
