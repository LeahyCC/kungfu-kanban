/* The agent-cancellation guard must fire on a real client disconnect and NOT
 * on a completed request. Regression: it used to hang off req's 'close', which
 * modern Node emits as soon as the body has been read — ~16ms in, long before
 * the agent finishes — so every draft/improve call SIGTERM'd the `claude`
 * process it had just spawned and failed with an empty, confusing error. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// the shape server.js uses (killOnDisconnect)
function killOnDisconnect(res, op) {
  res.on('close', () => { if (!res.writableFinished) op.kill(); });
}

function serve(handler) {
  const app = express();
  app.use(express.json());
  app.post('/t', handler);
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/t` }));
  });
}

test('a request that completes normally never kills the agent', async () => {
  let killed = false;
  const { s, url } = await serve((req, res) => {
    killOnDisconnect(res, { kill: () => { killed = true; } });
    setTimeout(() => res.json({ ok: true }), 120); // agent "work"
  });
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
    assert.deepEqual(await r.json(), { ok: true });
    await new Promise((r2) => setTimeout(r2, 60)); // let any late close land
    assert.equal(killed, false, 'agent was killed despite a completed response');
  } finally {
    s.close();
  }
});

test('a client that disconnects mid-flight kills the agent', async () => {
  let killed = false;
  const { s, url } = await serve((req, res) => {
    killOnDisconnect(res, { kill: () => { killed = true; } });
    setTimeout(() => { if (!res.writableEnded) res.json({ ok: true }); }, 3000); // slow agent
  });
  try {
    const ac = new AbortController();
    const p = fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"text":"x"}', signal: ac.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    ac.abort(); // user cancelled in the UI
    await p;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(killed, true, 'agent kept running after the client went away');
  } finally {
    s.close();
  }
});
