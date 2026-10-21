import { useCallback, useEffect, useState } from 'react';
import { useRpc } from '../rpc/rpc-context.jsx';
import { replyStore } from '../../../src/renderer/stage/use-question-reply.js';
import { frameReply } from '../../../src/renderer/stage/question-reply.cjs';

const EMPTY_QUEUE = { count: 0, items: [] };

function reasonFrom(error) {
  return String(error?.message || error || 'send failed');
}

export function useSend({ sessionId, paneId, onSent }) {
  const client = useRpc();
  const [queue, setQueue] = useState(EMPTY_QUEUE);
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);

  const showResult = useCallback((result, fallback) => {
    if (result?.ok === false) {
      setStatus({ phase: 'error', detail: String(result.reason) });
      return false;
    }
    if (result == null) return true;
    if (result.ok !== true) {
      setStatus({ phase: 'error', detail: fallback });
      return false;
    }
    return true;
  }, []);

  // A queue read while the socket is down is not an error worth a red line:
  // the reconnect below reads it again (2026-10-11, a cold boot painting from
  // the phone cache showed "not connected" twice under the conversation, and
  // the line outlived the reconnect because a good read never cleared it).
  const refreshQueue = useCallback(async () => {
    if (client.getState?.() !== 'connected') return;
    try {
      const next = await client.call('session:send-queue', { sessionId });
      setQueue(next || EMPTY_QUEUE);
      setStatus((current) => (current?.fromQueueRead ? null : current));
    } catch (error) {
      const reason = reasonFrom(error);
      if (/not connected|connection dropped/.test(reason)) return;
      setStatus({ phase: 'error', detail: reason, fromQueueRead: true });
    }
  }, [client, sessionId]);

  useEffect(() => {
    setQueue(EMPTY_QUEUE);
    setStatus(null);
    refreshQueue();
    const unsubscribe = client.onChannel('send:status', (next) => {
      if (next?.sessionId !== sessionId) return;
      setStatus(next);
      if (next.queue) setQueue(next.queue);
      else refreshQueue();
    });
    // THE QUEUE ROW IS ONLY EVER AS FRESH AS THE LAST PUSH THAT LANDED, and a
    // dropped socket delivers no pushes. This row is what read "sending:
    // /clear" on Pat's phone for minutes after the send had actually finished
    // (2026-08-08): the terminal `send:status` was written while his connection
    // was closed, and nothing re-read the queue afterwards, so a stale row
    // outlived the work it described. Re-fetching on reconnect is the whole
    // fix; the server has always been the authority here.
    const reconnected = client.onConnection?.((state) => {
      if (state === 'connected') refreshQueue();
    });
    return () => { unsubscribe(); reconnected?.(); };
  }, [client, refreshQueue, sessionId]);

  const send = useCallback(async (text, images = []) => {
    setSending(true);
    setStatus(null);
    const pane = paneId ? { paneId } : null;
    const reply = replyStore.get(sessionId);
    try {
      const result = reply ? await client.call('ask:decline', {id:reply.id,reason:frameReply(reply,text,images)}) : await client.call('session:send', {
        sessionId,
        text,
        images,
        pane,
        resumeOnly: false,
      });
      const ok = showResult(result, 'send failed');
      if (ok && reply) replyStore.cancel(sessionId,reply.id);
      // A read, not part of the send: an acknowledged send never waits on it
      // (2026-10-21, second Sol review: a stuck refresh kept Send spinning).
      refreshQueue().catch(() => {});
      if (ok) onSent?.(result);
      return { ok, result };
    } catch (error) {
      const reason = reasonFrom(error);
      setStatus({ phase: 'error', detail: reason });
      return { ok: false, result: { ok: false, reason } };
    } finally {
      setSending(false);
    }
  }, [client, onSent, paneId, refreshQueue, sessionId, showResult]);

  const cancel = useCallback(async (sendId) => {
    try {
      const result = await client.call('session:cancel-send', { sessionId, sendId });
      showResult(result, 'cancel failed');
      await refreshQueue();
      return result;
    } catch (error) {
      setStatus({ phase: 'error', detail: reasonFrom(error) });
      return null;
    }
  }, [client, refreshQueue, sessionId, showResult]);

  const interrupt = useCallback(async () => {
    try {
      const result = await client.call('session:interrupt', { paneId });
      showResult(result, 'interrupt failed');
      return result;
    } catch (error) {
      setStatus({ phase: 'error', detail: reasonFrom(error) });
      return null;
    }
  }, [client, paneId, showResult]);

  return { cancel, interrupt, queue, send, sending, status };
}
