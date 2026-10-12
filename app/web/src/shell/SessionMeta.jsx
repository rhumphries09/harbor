import React, { useEffect, useState } from 'react';
import turnMeta from '../../../src/renderer/stage/turn-meta.cjs';
import cacheFreshnessHelpers from '../../../src/renderer/stage/cache-freshness.cjs';
import { contextFact, statusFact } from './session-facts.js';

// The session facts under the phone header (2026-10-11, Pat: the phone
// "doesnt show like session context or stuff like that"). Every fact here was
// already arriving with each transcript update and going unshown: the context
// percentage, the working state, the cache facts. Meanings follow the desktop
// window header so one word means one thing on both:
//   context  the ring from header.contextPct (Claude's own statusline math);
//            tokens alone when the window size is unknown, never a guessed
//            percentage (the 2026-07-21 rule in main/providers/transcript.js)
//   status   "Working 1m 12s, 2.4k tokens" from the same live meter the
//            desktop shows (turn-meta.cjs), "Waiting on you", or "Idle 12m"
//   cache    prompt-cache warmth from the transcript's own usage facts

const { parseTokenCount, liveMeterLabel } = turnMeta;
const { cacheFreshness, describeCacheFreshness } = cacheFreshnessHelpers;

// The live meter, phone edition: the same CLI working line the desktop reads
// off the pane (session:work-meter, remote-safe since 2026-10-11), polled every
// 2 s only while the turn runs and the page is visible.
function useWorkMeter(client, session, pane, working, prompt) {
  const paneId = pane?.paneId || null;
  const active = Boolean(client && working && paneId && (session?.provider || 'claude') === 'claude');
  const [cli, setCli] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setCli(null);
    if (!active) return undefined;
    let alive = true;
    let timer = null;
    const tick = async () => {
      const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
      const next = visible ? await client.call('session:work-meter', { pane, sessionId: session.id }).catch(() => null) : null;
      if (!alive) return;
      if (next) setCli((prev) => ({ elapsed: next.elapsed || prev?.elapsed || null, tokens: parseTokenCount(next.tokens) ?? prev?.tokens ?? null }));
      setNow(Date.now());
      timer = setTimeout(tick, 2000);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, paneId, session?.id, prompt?.ts]);
  if (!active) return null;
  const startMs = prompt?.ts ? Date.parse(prompt.ts) : NaN;
  return liveMeterLabel({
    startMs: Number.isFinite(startMs) ? startMs : null,
    now,
    cliTokens: cli?.tokens ?? null,
    turnTokens: prompt?.turnMeta?.outputTokens ?? null,
    cliElapsed: cli?.elapsed || null,
  }) || null;
}

// Re-render on a coarse clock so "Idle 12m" and cache warmth age without a push.
function useClock(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function SessionMeta({ client, session, header, pane }) {
  const now = useClock(15000);
  const meter = useWorkMeter(client, session, pane, Boolean(header?.working), header?.lastPrompt || null);
  if (!session) return null;
  const context = contextFact(header) || (typeof session.contextPct === 'number' ? contextFact({ contextPct: session.contextPct }) : null);
  const status = statusFact({ session, header, meter, now });
  const cache = describeCacheFreshness(cacheFreshness({ touchedMs: header?.cacheTouchedMs, ttlMs: header?.cacheTtlMs, now }));
  return (
    <div className="hdr-meta" role="group" aria-label="Session details">
      {context ? (
        <span className={`hdr-ctx hdr-ctx-${context.kind}${context.warn ? ' warn' : ''}`} title={context.title} aria-label={context.title}>
          {context.kind === 'pct' ? <span className="hdr-ring" style={{ '--pct': `${context.pct}%` }} aria-hidden="true" /> : null}
          <span className="hdr-ctx-num">{context.label}</span>
          <span className="hdr-ctx-unit">context</span>
        </span>
      ) : null}
      <span className={`hdr-status hdr-status-${status.kind}`}>{status.label}</span>
      {cache ? <span className={`hdr-cache cache-${cache.state}`} title={cache.title}>{cache.label}</span> : null}
    </div>
  );
}
