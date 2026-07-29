/* Terminal keystroke ordering.
 *
 * Every keystroke is its own POST, and concurrent fetches have no ordering
 * guarantee — this was caught live: typing at machine speed into the board's
 * terminal delivered `echo "shell=$SHELL...` to the pty as
 * `echo "shell$=HSLEL zs=hZ$SH_VESROIN...`. A shell that scrambles fast input
 * is worse than no shell, so the queue serializes sends and coalesces whatever
 * is typed while a request is in flight. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDom } = require('./helpers/fake-dom.js');

const dom = installFakeDom();
let term;

test.before(async () => {
  term = await import('../public/js/term.js');
  dom.restoreTimers();
});

// A send whose completion we control, so "in flight" is a state we can hold.
function deferredSender() {
  const sent = [];
  const resolvers = [];
  const send = (chunk) => {
    sent.push(chunk);
    return new Promise((resolve) => resolvers.push(resolve));
  };
  return { sent, send, flushOne: () => resolvers.shift()() };
}

test('keystrokes reach the server in the order they were typed', async () => {
  const { sent, send, flushOne } = deferredSender();
  const push = term.inputQueue(send);

  push('l');
  push('s');
  push('\r');
  // Only the first is in flight; the rest wait rather than racing it.
  assert.deepEqual(sent, ['l'], 'one request in flight at a time');

  flushOne();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['l', 's\r'], 'keys typed mid-flight coalesce, in order');

  flushOne();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.join(''), 'ls\r', 'nothing reordered, nothing lost');
});

test('a burst of N keys costs far fewer than N requests', async () => {
  const { sent, send, flushOne } = deferredSender();
  const push = term.inputQueue(send);

  for (const ch of 'abcdefghij') push(ch);
  assert.equal(sent.length, 1, 'the burst did not fan out into 10 concurrent POSTs');

  flushOne();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['a', 'bcdefghij'], 'the other nine went as one ordered chunk');

  flushOne();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.join(''), 'abcdefghij', 'every keystroke survived, in order');
});

test('the queue keeps working after a failed send', async () => {
  const sent = [];
  let fail = true;
  const push = term.inputQueue(async (chunk) => {
    sent.push(chunk);
    if (fail) { fail = false; throw new Error('network died'); }
  });

  push('x');
  await new Promise((r) => setImmediate(r));
  push('y');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['x', 'y'], 'a dropped request does not wedge the queue');
});
