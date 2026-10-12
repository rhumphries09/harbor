import { useCallback, useEffect, useMemo, useState } from 'react';
import { CONNECTION } from '../rpc/client.js';
import { createDebouncedWriter, readCachedSidebar, writeCachedSidebar } from '../rpc/local-cache.js';

// The phone's session list. Since 2026-10-11 the server sends the phone a
// PROJECTION (src/server/phone-rail.js): live sessions plus the last 48 hours,
// a few dozen rows, instead of all history (3.96 MB, 4,368 rows, measured on
// the live server; fetched on every connect, pushed again right after, and
// re-fetched every 15 s). Wider drawer windows and search ask for theirs with
// `fetchSlice`. The last list is cached on the phone so a cold boot paints it
// before the socket is even up.
export function useSidebar(client) {
  const cached = useMemo(() => readCachedSidebar(), []);
  const [model, setModelState] = useState(cached?.model || { projects: [] });
  const [fromCache, setFromCache] = useState(Boolean(cached));
  const [loadError, setLoadError] = useState(null);
  const writer = useMemo(() => createDebouncedWriter((m) => writeCachedSidebar(m), 1000), []);

  const setModel = useCallback((next) => {
    setModelState(next);
    setFromCache(false);
    writer.schedule(next);
  }, [writer]);

  const refresh = useCallback(async () => {
    if (!client || client.getState() !== CONNECTION.connected) return;
    try {
      const state = await client.call('sidebar:get-state');
      setModel(state?.model || { projects: [] });
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error.message || error));
    }
  }, [client, setModel]);

  // The `sidebar:update` PUSH already carries this exact shape (the same
  // projection), so applying it directly needs no round trip. Before this, every
  // push made AppShell call `refresh()`, which re-fetched the full state over
  // RPC, whose response (identical bytes to the push that triggered it) is NEVER
  // coalesced the way pushes are (live-caught 2026-08-07).
  const applyPush = useCallback((payload) => {
    if (payload?.model) setModel(payload.model);
  }, [setModel]);

  // A wider window or a search: one request, its own result, never the push's
  // job. Returns null when not connected.
  const fetchSlice = useCallback(async (request) => {
    if (!client || client.getState() !== CONNECTION.connected) return null;
    const state = await client.call('sidebar:get-state', request);
    return state?.model ? state : null;
  }, [client]);

  // A slow safety net only: pushes and the refresh on every reconnect keep the
  // list current, and each projection is small.
  useEffect(() => {
    if (!client) return undefined;
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => { clearInterval(timer); writer.flush(); };
  }, [client, refresh, writer]);

  return { model, fromCache, loadError, refresh, applyPush, fetchSlice };
}
