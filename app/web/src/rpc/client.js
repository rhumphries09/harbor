import deriveServerUrlModule from './derive-server-url.cjs';

const { deriveServerUrl } = deriveServerUrlModule;

export const CONNECTION = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  connected: 'connected',
  error: 'error',
};

const STORAGE_SERVER = 'harbor-web-server';
const STORAGE_TOKEN = 'harbor-web-token';

// Close codes a browser can hand back with no `reason` string attached
// (a server-set reason always wins when present). Named here because
// "code 1006" means nothing to Pat mid-incident; "the connection dropped
// without a clean close" does.
const CLOSE_CODE_HINTS = {
  1000: 'closed normally',
  1001: 'server going away',
  // 1006 only says the close had no reason: the network, the tunnel or the
  // server went away. It cannot tell which, so it does not guess.
  1006: 'the connection closed without a reason (the network, Tailscale or the server went away)',
  1011: 'server hit an internal error',
  1013: 'server closed it: client too slow to drain pushes',
  1015: 'TLS handshake failed',
};

// A 64-character hex token is not something anyone should retype on a phone,
// and iOS gives a home-screen web app its own storage container, so pasting it
// once in Safari does NOT carry into the installed app: without this you would
// be asked for it at least twice, and again after any storage eviction.
//
// So the token can arrive in the URL FRAGMENT (#token=...&url=...). A fragment
// is never sent to the server and never lands in an access log, unlike a query
// string. It is consumed once, written to storage, and stripped from the address
// bar immediately so it does not survive in history or a shared screenshot.
export function ingestSetupFragment() {
  try {
    const raw = (window.location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    const token = params.get('token');
    if (!token) return null;
    const serverUrl = params.get('url') || defaultServerUrl();
    localStorage.setItem(STORAGE_TOKEN, token.trim());
    if (serverUrl) localStorage.setItem(STORAGE_SERVER, serverUrl.trim());
    // Strip it before anything can screenshot, bookmark or share the address.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return { serverUrl, token: token.trim() };
  } catch {
    return null;
  }
}

export function loadSettings() {
  try {
    ingestSetupFragment();
    return {
      serverUrl: localStorage.getItem(STORAGE_SERVER) || defaultServerUrl(),
      token: localStorage.getItem(STORAGE_TOKEN) || '',
    };
  } catch {
    return { serverUrl: '', token: '' };
  }
}

export function saveSettings({ serverUrl, token }) {
  localStorage.setItem(STORAGE_SERVER, serverUrl.trim());
  localStorage.setItem(STORAGE_TOKEN, token.trim());
}

export function defaultServerUrl() {
  if (typeof window === 'undefined') return '';
  return deriveServerUrl(window.location);
}

// Ask the server whether it needs a secret at all, instead of assuming it does.
// Over the tailnet the answer is no, because Tailscale authenticated the device
// before the request could arrive, and the token screen never appears. Anywhere
// else the answer is yes and the screen behaves exactly as before.
//
// This is what makes a cold launch from the home screen work: iOS gives the
// installed app its OWN storage container, so it starts with no token no matter
// what was pasted into Safari, and the old gate had no way to tell that state
// apart from "not set up yet".
//
// BOUNDED, AND "COULD NOT ASK" IS NOT "NO" (2026-10-21 review, finding 3). The
// fetch had no deadline, so a launch during a dead tunnel sat on the splash for
// as long as the OS let it, and a network failure was reported as "a token is
// required", which sent a phone with a passing outage to the setup form.
const PROBE_TIMEOUT_MS = 4000;
export async function probeAuth(serverUrl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const base = serverUrl || defaultServerUrl();
  if (!base) return { authenticated: false, tokenRequired: true, login: null };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(new URL('/whoami', base).toString(), {
      cache: 'no-store',
      credentials: 'omit',
      ...(controller ? { signal: controller.signal } : {}),
    });
    // A proxy in front of a restarting server answers 502/503: unavailable.
    if (response.status >= 500) return { authenticated: false, tokenRequired: true, login: null, unavailable: true };
    // A server older than /whoami answers 404: the old behaviour, ask for a token.
    if (!response.ok) return { authenticated: false, tokenRequired: true, login: null };
    const body = await response.json();
    return {
      authenticated: Boolean(body?.authenticated),
      tokenRequired: body?.tokenRequired !== false,
      login: body?.login || null,
    };
  } catch {
    return { authenticated: false, tokenRequired: true, login: null, unavailable: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wsUrlFromHttp(serverUrl, token) {
  const base = new URL(serverUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/ws';
  base.search = '';
  if (token) base.searchParams.set('token', token);
  return base.toString();
}

// RETURNING TO THE APP MUST NOT FEEL LIKE A RELOAD (Pat, 2026-10-11: "if i
// leave the app for like 5 seconds and return to it (without closing the app)
// it reloads and takes a while"). iOS closes a backgrounded web app's socket
// (the server log is a wall of 1006 closes), and this client then waited a
// FIXED 4 s before even trying again, on a return that the page itself can
// see happening. Now: the page coming back (visibilitychange to visible,
// pageshow, focus, online) reconnects at once; a socket that still SAYS open
// after a suspend is proven with one small round trip and replaced if it does
// not answer within PROBE_MS; and a genuinely failing link backs off
// 250 ms, 1 s, 2 s, then 4 s, instead of 4 s from the first miss.
const RECONNECT_STEPS_MS = [250, 1000, 2000, 4000];
const PROBE_MS = 2500;
const WAKE_DEBOUNCE_MS = 400;
// A HANDSHAKE THAT NEVER FINISHES IS A FAILURE TOO (2026-10-21, Pat's phone sat
// on "Connecting…" and "Cannot reach harbor-server" at 08:14 while the server
// answered loopback in milliseconds). A socket opened while iOS was still
// bringing the Tailscale tunnel back can sit in CONNECTING until the OS gives up
// on the TCP connect, tens of seconds later, and nothing here retried, because
// the backoff only runs on a close and wake() ignored a CONNECTING socket. A
// healthy handshake over the tailnet takes well under two seconds.
const CONNECT_TIMEOUT_MS = 6000;
// On wake, a handshake older than this was started before the app was
// suspended (or in the dead tunnel just after) and is replaced at once.
const WAKE_STALE_CONNECT_MS = 1500;
// AN OPEN SOCKET IS PROVEN WHILE THE APP IS ON SCREEN (2026-10-21 review,
// finding 4). A network handoff (Wi-Fi to cellular, a tunnel re-key) can
// swallow a connection without a close ever reaching the phone, so the socket
// keeps saying OPEN, every call waits forever and a send spins until something
// else wakes the page. One small round trip every HEARTBEAT_MS while visible,
// and no answer within HEARTBEAT_ANSWER_MS replaces the socket and fails what
// was waiting on it (the composer keeps its text and says so).
// EVERY REQUEST ENDS (2026-10-21, second Sol review). The heartbeat proves the
// socket, not each operation: a server that kept answering heartbeats while one
// call never came back left Send spinning forever. Each call now has a
// deadline sized to its work; a send or an answer may wait on a starting
// session for minutes, a read never should. A timed-out action may still have
// happened, so the error says to check before repeating it, and nothing is
// ever resent automatically.
const CALL_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 240_000;
const ACTION_METHODS = new Set([
  'session:send', 'resume-session', 'new-session', 'session:takeover', 'session:menu-answer',
  'ask:answer', 'ask:decline', 'upload:image', 'whisper:transcribe', 'voice:token',
  'capabilities:cycle-permission-mode', 'session:interrupt',
]);
const HEARTBEAT_MS = 20000;
const HEARTBEAT_ANSWER_MS = 5000;

export function createRpcClient({
  serverUrl, token, onPush, onConnectionChange, lifecycle = null,
  connectTimeoutMs = CONNECT_TIMEOUT_MS, wakeStaleConnectMs = WAKE_STALE_CONNECT_MS,
  heartbeatMs = HEARTBEAT_MS, heartbeatAnswerMs = HEARTBEAT_ANSWER_MS,
  callTimeoutMs = CALL_TIMEOUT_MS, actionTimeoutMs = ACTION_TIMEOUT_MS,
}) {
  let ws = null;
  let failedAttempts = 0;
  let lastWakeAt = 0;
  let connectStartedAt = 0;
  let connectTimer = null;
  let heartbeatTimer = null;
  let detachLifecycle = null;
  let nextId = 1;
  const pending = new Map();
  let state = CONNECTION.disconnected;
  let reconnectTimer = null;
  let manualClose = false;
  let lastError = null;
  let connectCount = 0;
  // Per-channel subscriptions, additive to the single `onPush` callback above
  // (kept for the sidebar's existing use). The conversation and ask surfaces
  // each need their own push channel (transcript:update) without racing each
  // other for one callback slot.
  const channelListeners = new Map();
  const connectionListeners = new Set();

  function setState(next, error = null) {
    if (state === next && error === lastError) return;
    state = next;
    lastError = error;
    onConnectionChange?.(next, error);
    for (const fn of connectionListeners) {
      try { fn(next, error); } catch { /* a listener must not break the socket */ }
    }
  }

  // EVERY CALL SETTLES. A promise handed to a caller is a promise that resolves
  // or rejects; there is no third outcome, and a socket that dies is not
  // permission to invent one.
  //
  // This is the defect Pat photographed on 2026-08-08: his phone showed
  // "sending: /clear" with the send spinner turning and his typed text still in
  // the box, permanently. `session:send` had gone out, the socket was closed
  // under it by the queue overflow, and the pending entry simply sat in this
  // map for the life of the page. The composer awaits that promise before it
  // clears the field or reports anything, so a lost response reads to a human
  // as an app that has silently stopped working, which is strictly worse than
  // an error: an error can be retried.
  //
  // The reason is carried through so the composer can say what happened rather
  // than a bare "failed".
  function failPending(reason) {
    if (!pending.size) return;
    const error = new Error(reason);
    const entries = [...pending.values()];
    pending.clear();
    for (const handler of entries) { clearTimeout(handler.timer); handler.reject(error); }
  }

  function connect() {
    manualClose = false;
    connectCount += 1;
    attachLifecycle();
    if (!serverUrl) {
      setState(CONNECTION.error, 'server URL is required');
      return;
    }
    setState(CONNECTION.connecting);
    let socket;
    try {
      socket = new WebSocket(wsUrlFromHttp(serverUrl, token));
      ws = socket;
    } catch (error) {
      setState(CONNECTION.error, String(error.message || error));
      scheduleReconnect();
      return;
    }
    const current = () => ws === socket;
    connectStartedAt = Date.now();
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      connectTimer = null;
      const CONNECTING = globalThis.WebSocket?.CONNECTING ?? 0;
      if (current() && socket.readyState === CONNECTING) {
        failedAttempts += 1;
        replaceSocket('the server did not answer the handshake', { countFailure: true });
      }
    }, connectTimeoutMs);
    socket.onopen = () => {
      if (!current()) return;
      clearTimeout(connectTimer);
      connectTimer = null;
      failedAttempts = 0;
      setState(CONNECTION.connected);
      startHeartbeat(socket);
    };
    // onerror never carries a real reason (the WebSocket spec deliberately
    // hides it from the error event for security), and onclose fires right
    // after onerror for every failed connection, so onerror's message was
    // being set and then immediately clobbered back to a bare 'disconnected'
    // before React ever painted it. The CloseEvent itself DOES carry a code
    // and (for a same-origin close) a reason, so onclose is the one place
    // that can report anything specific; onerror is left as a no-op signal.
    socket.onclose = (event) => {
      // A socket this client already replaced (a failed wake probe) closes
      // late; it must not tear down its successor.
      if (!current()) return;
      clearTimeout(connectTimer);
      connectTimer = null;
      ws = null;
      const code = event?.code;
      const reason = event?.reason || CLOSE_CODE_HINTS[code] || `code ${code ?? 'unknown'}`;
      // Before the state change, so anything reacting to `disconnected` sees a
      // map with nothing stranded in it.
      failPending(`the connection dropped before the server answered (${reason})`);
      if (!manualClose) setState(CONNECTION.disconnected, reason);
      scheduleReconnect();
    };
    socket.onerror = () => {};
    socket.onmessage = (event) => {
      if (!current()) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'push') {
        onPush?.(message.channel, ...(message.args || []));
        const listeners = channelListeners.get(message.channel);
        if (listeners) for (const fn of listeners) fn(...(message.args || []));
        return;
      }
      if (message.type === 'response') {
        const handler = pending.get(message.id);
        if (!handler) return;
        pending.delete(message.id);
        clearTimeout(handler.timer);
        if (message.error) handler.reject(new Error(message.error));
        else handler.resolve(message.result);
      }
    };
  }

  function startHeartbeat(socket) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      const doc = lifecycle?.document ?? (typeof document !== 'undefined' ? document : null);
      if (ws !== socket) { clearInterval(heartbeatTimer); heartbeatTimer = null; return; }
      if (doc && doc.visibilityState === 'hidden') return;
      probe(socket, heartbeatAnswerMs, 'no answer from the server');
    }, heartbeatMs);
  }

  // One round trip on `socket`; silence past `answerMs` replaces it. Any reply
  // proves the transport, an error reply included.
  let probing = null;
  function probe(socket, answerMs, reason) {
    if (probing === socket) return;
    probing = socket;
    let answered = false;
    const timer = setTimeout(() => {
      if (probing === socket) probing = null;
      if (!answered && ws === socket) replaceSocket(reason);
    }, answerMs);
    const settle = () => { answered = true; clearTimeout(timer); if (probing === socket) probing = null; };
    call('daemon:get-banner').then(settle, (error) => {
      if (/not connected|connection dropped/.test(String(error?.message))) return;
      settle();
    });
  }

  function disconnect() {
    manualClose = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearTimeout(connectTimer);
    connectTimer = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    detachLifecycle?.();
    detachLifecycle = null;
    failPending('disconnected');
    ws?.close();
    ws = null;
    setState(CONNECTION.disconnected);
  }

  function scheduleReconnect() {
    if (manualClose || reconnectTimer) return;
    const delay = RECONNECT_STEPS_MS[Math.min(failedAttempts, RECONNECT_STEPS_MS.length - 1)];
    failedAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // Abandon a socket that cannot be trusted (no answer to the wake probe) and
  // start a fresh one now, without waiting for its close event, which on a
  // dead link can take a TCP timeout to arrive.
  function replaceSocket(reason, { countFailure = false } = {}) {
    const stale = ws;
    ws = null;
    clearTimeout(connectTimer);
    connectTimer = null;
    if (stale) {
      stale.onopen = stale.onmessage = stale.onerror = stale.onclose = null;
      try { stale.close(4000, reason); } catch { /* already gone */ }
    }
    failPending(`the connection dropped before the server answered (${reason})`);
    setState(CONNECTION.disconnected, reason);
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    // A timed-out handshake keeps its count so the shell can tell a long outage
    // from a blip; a wake or a manual retry starts the ladder over.
    if (!countFailure) failedAttempts = 0;
    connect();
  }

  // The person asked for a retry (the connection pill). A socket that is open
  // is proven the same way a wake proves it; anything else is replaced now.
  function reconnectNow() {
    if (manualClose) return;
    const OPEN = globalThis.WebSocket?.OPEN ?? 1;
    if (ws && ws.readyState === OPEN) { lastWakeAt = 0; wake(); return; }
    replaceSocket('retrying now');
  }

  // The page came back (or the network did). Reconnect now instead of waiting
  // out a backoff step that was scheduled while the app was in the background;
  // and if the socket claims to be open, make it prove it.
  function wake() {
    if (manualClose) return;
    const at = Date.now();
    if (at - lastWakeAt < WAKE_DEBOUNCE_MS) return;
    lastWakeAt = at;
    const OPEN = globalThis.WebSocket?.OPEN ?? 1;
    const CONNECTING = globalThis.WebSocket?.CONNECTING ?? 0;
    if (!ws || (ws.readyState !== OPEN && ws.readyState !== CONNECTING)) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      failedAttempts = 0;
      connect();
      return;
    }
    if (ws.readyState === CONNECTING) {
      // A fresh handshake is left to finish; one that was already running
      // when the app went away is the dead-tunnel case and is replaced.
      if (at - connectStartedAt >= wakeStaleConnectMs) replaceSocket('a connection attempt from before the app was suspended');
      return;
    }
    probe(ws, PROBE_MS, 'no answer after the app came back');
  }

  function attachLifecycle() {
    if (detachLifecycle) return;
    const win = lifecycle?.window ?? (typeof window !== 'undefined' ? window : null);
    const doc = lifecycle?.document ?? (typeof document !== 'undefined' ? document : null);
    if (!win && !doc) return;
    const onVisible = () => { if (!doc || doc.visibilityState !== 'hidden') wake(); };
    doc?.addEventListener?.('visibilitychange', onVisible);
    win?.addEventListener?.('pageshow', wake);
    win?.addEventListener?.('focus', onVisible);
    win?.addEventListener?.('online', wake);
    detachLifecycle = () => {
      doc?.removeEventListener?.('visibilitychange', onVisible);
      win?.removeEventListener?.('pageshow', wake);
      win?.removeEventListener?.('focus', onVisible);
      win?.removeEventListener?.('online', wake);
    };
  }

  function call(method, payload, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      const id = nextId++;
      const limit = timeoutMs ?? (ACTION_METHODS.has(method) ? actionTimeoutMs : callTimeoutMs);
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        const seconds = Math.round(limit / 1000);
        const error = new Error(ACTION_METHODS.has(method)
          ? `Harbor did not answer within ${seconds} s. It may still have happened: check the conversation before trying again`
          : `Harbor did not answer within ${seconds} s`);
        error.code = 'TIMEOUT';
        reject(error);
      }, limit);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, payload }));
    });
  }

  function onChannel(channel, fn) {
    if (!channelListeners.has(channel)) channelListeners.set(channel, new Set());
    channelListeners.get(channel).add(fn);
    return () => channelListeners.get(channel)?.delete(fn);
  }

  // A RECONNECT IS A NEW CLIENT AS FAR AS THE SERVER IS CONCERNED, and the
  // things a view opened do not survive it.
  //
  // `transcript:open` is refcounted per clientId (server/client-resources.js)
  // and released when the socket closes, so after a drop the server stops
  // pushing that session's updates entirely, and nothing on this side ever
  // asked again: the conversation quietly stopped updating and no amount of
  // waiting fixed it. Send-queue state has the same shape, fetched once and
  // then only ever updated by pushes that a dead socket cannot deliver.
  //
  // So views subscribe here and re-establish what they hold when the
  // connection comes back. This is deliberately a subscription rather than the
  // single `onConnectionChange` callback the shell already owns, for the same
  // reason `onChannel` exists: more than one view needs it, and one callback
  // slot cannot be shared.
  function onConnection(fn) {
    connectionListeners.add(fn);
    return () => connectionListeners.delete(fn);
  }

  return {
    connect,
    disconnect,
    call,
    onChannel,
    onConnection,
    getState: () => state,
    getLastError: () => lastError,
    getConnectCount: () => connectCount,
    getFailedAttempts: () => failedAttempts,
    wake,
    reconnectNow,
  };
}
