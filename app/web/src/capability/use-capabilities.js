import { useCallback, useEffect, useState } from 'react';

export function useCapabilities(client, session) {
  const [capabilities, setCapabilities] = useState(null);
  const [options, setOptions] = useState(null);
  const [permissionMode, setPermissionMode] = useState(undefined);
  const [error, setError] = useState(null);

  // Read only while connected, and again on every reconnect: a composer that
  // mounted offline (a cold boot painting from the phone cache, 2026-10-11)
  // used to show "not connected" in red and keep an empty slash menu forever,
  // because nothing re-read the capabilities once the socket came back.
  const refresh = useCallback(async () => {
    if (!client || !session?.id) return;
    if (client.getState?.() !== 'connected') return;
    try {
      const caps = await client.call('capabilities:get', { sessionId: session.id });
      if (!caps?.ok) throw new Error(caps?.reason || 'Capabilities unavailable');
      setCapabilities(caps.capabilities);
      const [nextOptions, permission] = await Promise.all([
        client.call('new-session:options').catch(() => null),
        session.paneId
          ? client.call('capabilities:permission-mode', { paneId: session.paneId }).catch(() => ({ mode: null }))
          : Promise.resolve({ mode: null }),
      ]);
      setOptions(nextOptions);
      setPermissionMode(permission?.mode ?? null);
      setError(null);
    } catch (cause) {
      setError(String(cause?.message || cause));
    }
  }, [client, session?.id, session?.paneId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => client?.onChannel('provider-models:changed', refresh), [client, refresh]);
  useEffect(() => client?.onConnection?.((state) => { if (state === 'connected') refresh(); }), [client, refresh]);
  return { capabilities, options, permissionMode, setPermissionMode, error, refresh };
}
