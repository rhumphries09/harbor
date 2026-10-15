'use strict';

const { SessionDaemonClient } = require('./client.js');
const { SessionStreamSupervisor } = require('./streams.js');

const BACKEND_ENV = 'HARBOR_SESSION_BACKEND';

function resolveSessionBackend(env = process.env) {
  const value = String(env?.[BACKEND_ENV] || 'sessiond').trim().toLowerCase();
  if (value === 'herdr') {
    throw new Error(`${BACKEND_ENV}=herdr is no longer supported because the Herdr backend was retired; use sessiond`);
  }
  if (value !== 'sessiond') throw new Error(`${BACKEND_ENV} must be sessiond, got ${value}`);
  return 'sessiond';
}

function assertStoreAllowed(policy) {
  if (policy && !policy.allowed) {
    const error = new Error(policy.reason);
    error.code = 'SESSION_STORE_BLOCKED';
    throw error;
  }
}

function createControlClient(options = {}) {
  const env = options.env || process.env;
  resolveSessionBackend(env);
  assertStoreAllowed(options.sessionStorePolicy);
  const Client = options.SessionDaemonClient || SessionDaemonClient;
  return new Client({
    socketPath: options.sessionSocketPath || env.HARBOR_SESSIOND_SOCKET,
    requestTimeoutMs: options.requestTimeoutMs,
    env,
  });
}

function createStreamSupervisor(options = {}) {
  const env = options.env || process.env;
  resolveSessionBackend(env);
  assertStoreAllowed(options.sessionStorePolicy);
  const Supervisor = options.SessionStreamSupervisor || SessionStreamSupervisor;
  return new Supervisor({ socketPath: options.sessionSocketPath || env.HARBOR_SESSIOND_SOCKET, env });
}

// One health question on its own connection, closed afterwards. Every caller
// that pinged through a fresh client and walked away left that connection open
// on both ends for the life of the process: the app's watchdog alone did it
// every 30 s, measured as four new daemon handles a minute (2026-10-14: 1,105
// handles on a daemon serving five sessions).
async function pingDaemonOnce(options = {}) {
  const client = createControlClient(options);
  try {
    return await client.ping();
  } finally {
    try { client.close(); } catch { /* already gone */ }
  }
}

module.exports = { BACKEND_ENV, resolveSessionBackend, createControlClient, createStreamSupervisor, pingDaemonOnce };
