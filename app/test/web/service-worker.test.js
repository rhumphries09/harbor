'use strict';

// The phone's service worker opens the SAVED app when the server cannot serve
// a fresh one (2026-10-21 review, finding 15): `tailscale serve` answers a
// restarting server with a 502, a resolved fetch, so the old catch-only
// fallback never fired and the phone showed the proxy's error page. Two-sided:
// a 5xx, an error or a slow network serve the saved shell; a healthy answer is
// served and refreshes the saved copy; an auth refusal still reaches the page.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../web/public/sw.js'), 'utf8');
const ORIGIN = 'https://phone.example.ts.net';

function loadWorker({ network, putFails = false }) {
  const listeners = {};
  const store = new Map();
  const cacheApi = {
    async open() {
      return { put: async (key, res) => { if (putFails) throw new Error('QuotaExceededError'); store.set(String(key), await res.text()); } };
    },
    async match(key) {
      const k = typeof key === 'string' ? key : key.url;
      return store.has(k) ? new Response(store.get(k), { status: 200 }) : undefined;
    },
    async keys() { return []; },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  // The document wait is shortened 100x so the slow case runs in milliseconds.
  const fastTimeout = (fn, ms) => setTimeout(fn, ms / 100);
  new Function('self', 'caches', 'fetch', 'setTimeout', SOURCE)(self, cacheApi, network, fastTimeout);
  return {
    store,
    async navigate() {
      let responded;
      const waits = [];
      listeners.fetch({
        request: { method: 'GET', url: `${ORIGIN}/`, mode: 'navigate', headers: new Headers({ accept: 'text/html' }) },
        respondWith: (promise) => { responded = promise; },
        waitUntil: (promise) => waits.push(promise),
      });
      const res = await responded;
      await Promise.all(waits);
      return res;
    },
  };
}

const ok = (body) => async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

test('a healthy launch is served from the network and refreshes the saved shell', async () => {
  const worker = loadWorker({ network: ok('<html>v2</html>') });
  const res = await worker.navigate();
  assert.equal(await res.text(), '<html>v2</html>');
  assert.equal(worker.store.get('/index.html'), '<html>v2</html>');
});

test('a 502 from the proxy during a restart opens the saved app, not the error page', async () => {
  const worker = loadWorker({ network: ok('<html>v1</html>') });
  await worker.navigate();
  const down = loadWorker({ network: async () => new Response('Bad Gateway', { status: 502 }) });
  down.store.set('/index.html', '<html>v1</html>');
  const res = await down.navigate();
  assert.equal(await res.text(), '<html>v1</html>');
});

test('with nothing saved, the 502 is what the page gets', async () => {
  const worker = loadWorker({ network: async () => new Response('Bad Gateway', { status: 502 }) });
  const res = await worker.navigate();
  assert.equal(res.status, 502);
});

// Second Sol review, P0: the late answer used to REPLACE the saved shell after
// the old one was served. That page was never loaded, so its bundle was never
// cached, and the next offline launch was blank. A late answer is dropped.
test('a network that does not answer in time opens the saved app and keeps it as the saved app', async () => {
  let release;
  const worker = loadWorker({
    network: () => new Promise((resolve) => { release = () => resolve(new Response('<html>v3</html>', { status: 200 })); }),
  });
  worker.store.set('/index.html', '<html>v1</html>');
  const pending = worker.navigate();
  await new Promise((resolve) => setTimeout(resolve, 80));
  release();
  const res = await pending;
  assert.equal(await res.text(), '<html>v1</html>', 'the saved shell answered the slow launch');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(worker.store.get('/index.html'), '<html>v1</html>', 'a page that was never loaded never replaces the one that works');
});

test('a thrown fetch (offline) opens the saved app', async () => {
  const worker = loadWorker({ network: async () => { throw new TypeError('Failed to fetch'); } });
  worker.store.set('/index.html', '<html>v1</html>');
  const res = await worker.navigate();
  assert.equal(await res.text(), '<html>v1</html>');
});

test('an authentication refusal still reaches the page', async () => {
  const worker = loadWorker({ network: async () => new Response('no', { status: 401 }) });
  worker.store.set('/index.html', '<html>v1</html>');
  const res = await worker.navigate();
  assert.equal(res.status, 401);
});

// Second Sol review: a refused cache write (storage full) cost the fresh page.
test('a cache that refuses the write still serves the fresh page', async () => {
  const worker = loadWorker({ network: ok('<html>v2</html>'), putFails: true });
  const res = await worker.navigate();
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>v2</html>');
});
