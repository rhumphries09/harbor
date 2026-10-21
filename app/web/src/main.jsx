import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  defaultServerUrl,
  loadSettings,
  probeAuth,
  saveSettings,
} from './rpc/client.js';
import { AppShell } from './shell/AppShell.jsx';
import setupGateModule from './rpc/setup-gate.cjs';
import './styles.css';

const { setupGate } = setupGateModule;

function ConnectScreen({ initial, onConnect }) {
  const [serverUrl, setServerUrl] = useState(initial.serverUrl || defaultServerUrl());
  const [token, setToken] = useState(initial.token || '');
  const [error, setError] = useState('');

  const submit = (event) => {
    event.preventDefault();
    const trimmedUrl = serverUrl.trim();
    if (!trimmedUrl) {
      setError('Server URL is required');
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(trimmedUrl);
    } catch {
      setError('Enter a full URL like https://your-machine.your-tailnet.ts.net');
      return;
    }
    if (!token.trim()) {
      setError('Paste the token from harbor-server (server-token file)');
      return;
    }
    setError('');
    onConnect({ serverUrl: trimmedUrl.replace(/\/$/, ''), token: token.trim() });
  };

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="connect-mark" aria-hidden="true" />
        <h1>Harbor</h1>
        <p className="connect-lead">
          Connect to your harbor-server over Tailscale. The token lives in your
          Harbor config as <code>server-token</code>.
        </p>
        <form onSubmit={submit}>
          <label>
            <span>Server URL</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://your-machine.your-tailnet.ts.net"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
          </label>
          <label>
            <span>Token</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="64-character hex token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          {error ? <p className="connect-error" role="alert">{error}</p> : null}
          <button type="submit" className="btn-primary">Connect</button>
        </form>
      </div>
    </div>
  );
}

// A phone the tailnet has authenticated before (no token stored) may open its
// SAVED list and conversations while the server cannot be asked; the socket
// still has to authenticate before anything reaches the server
// (setup-gate.cjs).
const AUTH_OK_KEY = 'harbor-web-tailnet-ok';
function rememberAuthenticated(serverUrl) {
  try { localStorage.setItem(AUTH_OK_KEY, serverUrl || ''); } catch { /* memory only */ }
}
function wasAuthenticated(serverUrl) {
  try { return localStorage.getItem(AUTH_OK_KEY) === (serverUrl || ''); } catch { return false; }
}

function Splash({ unavailable = false }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-mark" />
      <p>{unavailable ? 'Can’t reach Harbor on your PC yet. Still trying…' : 'Connecting to Harbor…'}</p>
    </div>
  );
}

function App() {
  const [settings, setSettings] = useState(() => loadSettings());
  const [auth, setAuth] = useState(null);
  const [forceSetup, setForceSetup] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    // An unreachable server is asked again (every 3 s, and at once when the
    // page or the network comes back) instead of being taken as "token
    // required"; see setup-gate.cjs.
    //
    // Only the NEWEST answer counts, and "could not ask" never undoes an
    // answer already given (2026-10-21, second Sol review): a slow first probe
    // that came back 503 after a newer one had succeeded replaced the success,
    // unmounted a connected app and closed its socket. Unavailability is the
    // connection pill's to report; only an explicit refusal re-gates.
    let cancelled = false;
    let timer = null;
    let generation = 0;
    const ask = () => {
      clearTimeout(timer);
      const mine = ++generation;
      probeAuth(settings.serverUrl).then((result) => {
        if (cancelled || mine !== generation) return;
        if (result.authenticated) rememberAuthenticated(settings.serverUrl);
        setAuth((prior) => (result.unavailable && prior && !prior.unavailable ? prior : result));
        if (result.unavailable) timer = setTimeout(ask, 3000);
      });
    };
    const again = () => { if (document.visibilityState !== 'hidden') ask(); };
    ask();
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [settings.serverUrl]);

  const gate = setupGate({ settings, auth, rememberedAuth: wasAuthenticated(settings.serverUrl) });
  if (gate === 'pending') return <Splash unavailable={Boolean(auth?.unavailable)} />;

  if (gate === 'setup' || forceSetup) {
    return (
      <ConnectScreen
        initial={settings}
        onConnect={(next) => {
          saveSettings(next);
          setSettings(next);
          setForceSetup(false);
        }}
      />
    );
  }

  return (
    <AppShell
      settings={settings}
      auth={auth}
      onRequestSetup={() => setForceSetup(true)}
      onSignOut={() => {
        try { localStorage.removeItem(AUTH_OK_KEY); } catch { /* nothing to forget */ }
        const cleared = { serverUrl: settings.serverUrl, token: '' };
        saveSettings(cleared);
        setSettings(cleared);
        setForceSetup(true);
      }}
    />
  );
}

createRoot(document.getElementById('root')).render(<App />);
