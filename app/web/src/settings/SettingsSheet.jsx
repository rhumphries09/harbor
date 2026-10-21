import React, { useCallback, useEffect, useState } from 'react';
import { CONNECTION, probeAuth } from '../rpc/client.js';
import './settings.css';

// What the sheet says about the link, in the words the header pill uses.
function connectionLabel(connection) {
  if (connection === CONNECTION.connected) return 'Connected';
  if (connection === CONNECTION.connecting) return 'Reconnecting';
  return 'Offline, retrying on its own';
}

// HOW THIS PHONE IS SIGNED IN, not instructions (2026-10-21 review): an
// already-connected phone was told "Yes, paste the server token to connect".
function signInLabel(auth, hasToken) {
  if (hasToken) return 'Server token saved on this phone';
  if (!auth) return 'Checking…';
  if (auth.unavailable) return 'Unknown until Harbor answers';
  if (auth.authenticated) return auth.login ? `Tailnet, as ${auth.login}` : 'Tailnet device';
  return 'Needs the server token';
}

// Retry and Change server were one button that sent you to the setup screen
// (2026-10-21 review): a person whose phone dropped off Wi-Fi had to re-enter
// the server to try again. Retry now reconnects in place, keeping the screen,
// the drafts and the settings; changing server and signing out are separate,
// each with its own confirmation saying what it does.
export function SettingsSheet({
  open,
  onClose,
  serverUrl,
  hasToken = false,
  connection = CONNECTION.connected,
  onRetry,
  auth: initialAuth,
  onRequestSetup,
  onSignOut,
}) {
  const [auth, setAuth] = useState(initialAuth);
  const [confirming, setConfirming] = useState(null); // null | 'server' | 'signout'

  useEffect(() => {
    if (!open) {
      setConfirming(null);
      return undefined;
    }
    let cancelled = false;
    setAuth(initialAuth);
    probeAuth(serverUrl).then((result) => {
      if (!cancelled) setAuth(result);
    });
    return () => { cancelled = true; };
  }, [open, serverUrl, initialAuth]);

  const onBackdrop = useCallback((event) => {
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  if (!open) return null;

  const online = connection === CONNECTION.connected;

  return (
    <div
      className="settings-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={onBackdrop}
    >
      <div className="settings-panel">
        <header className="settings-head">
          <h2 className="settings-title">Settings</h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          <div className="settings-row">
            <span className="settings-label">Connection</span>
            <span className={`settings-value settings-conn ${online ? 'is-online' : 'is-offline'}`}>{connectionLabel(connection)}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Server</span>
            <span className="settings-value">{serverUrl || 'Not set'}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Signed in with</span>
            <span className="settings-value settings-value-muted">{signInLabel(auth, hasToken)}</span>
          </div>
        </div>

        <footer className="settings-actions">
          {confirming === 'server' ? (
            <>
              <p className="settings-confirm">
                This shows the server setup screen so you can enter a different
                server. Your sessions keep running on the PC.
              </p>
              <div className="settings-confirm-actions">
                <button type="button" className="settings-btn" onClick={() => setConfirming(null)}>Cancel</button>
                <button
                  type="button"
                  className="settings-btn settings-btn-primary"
                  onClick={() => { onRequestSetup?.(); onClose(); }}
                >
                  Change server
                </button>
              </div>
            </>
          ) : confirming === 'signout' ? (
            <>
              <p className="settings-confirm">
                This removes the server token from this phone. You will need to
                paste it again to reconnect.
              </p>
              <div className="settings-confirm-actions">
                <button type="button" className="settings-btn" onClick={() => setConfirming(null)}>Cancel</button>
                <button
                  type="button"
                  className="settings-btn settings-btn-danger"
                  onClick={() => { onSignOut?.(); onClose(); }}
                >
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="settings-btn settings-btn-primary"
                onClick={() => { onRetry?.(); onClose(); }}
              >
                {online ? 'Refresh connection' : 'Retry connection now'}
              </button>
              <div className="settings-secondary">
                <button type="button" className="settings-btn" onClick={() => setConfirming('server')}>Change server</button>
                <button type="button" className="settings-btn settings-btn-quiet" onClick={() => setConfirming('signout')}>Sign out</button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
