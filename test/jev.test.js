const fs = require('fs');
const os = require('os');
const path = require('path');
// KFK_DATA_DIR must be set before requiring lib/store so save() never
// touches the real board's tasks.json.
process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-jev-'));

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { shadowRoute, pickModel, buildRequest, MAX_PROMPT_CHARS } = require('../lib/jev');

const realFetch = global.fetch;
const realKey = process.env.KFK_TYPESAFE_KEY;
let calls;

function mockFetch(respond) {
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return respond();
  };
}
const ok = (score, confidence = 0.8) => ({
  ok: true,
  json: async () => ({ answers: { difficulty: { type: 'score', score, confidence } } }),
});

beforeEach(() => {
  process.env.KFK_TYPESAFE_KEY = 'test-key';
});
after(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.KFK_TYPESAFE_KEY;
  else process.env.KFK_TYPESAFE_KEY = realKey;
  fs.rmSync(process.env.KFK_DATA_DIR, { recursive: true, force: true });
});

test('pickModel: difficulty bands map cheapest to strongest', () => {
  assert.equal(pickModel(0), 'haiku');
  assert.equal(pickModel(0.66), 'haiku');
  assert.equal(pickModel(0.67), 'sonnet');
  assert.equal(pickModel(1.49), 'sonnet');
  assert.equal(pickModel(1.5), 'opus');
  assert.equal(pickModel(2), 'opus');
});

test('the SDK TYPESAFE_API_KEY alone does not opt a board in', async () => {
  delete process.env.KFK_TYPESAFE_KEY;
  const prev = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'someone-elses-key';
  mockFetch(() => ok(1));
  const task = { id: 't0', title: 'x', prompt: 'y' };
  try {
    await shadowRoute(task);
  } finally {
    if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prev;
  }
  assert.equal(calls.length, 0);
  assert.equal(task.jevRoute, undefined);
});

test('no API key: no call, card untouched', async () => {
  delete process.env.KFK_TYPESAFE_KEY;
  mockFetch(() => ok(1));
  const task = { id: 't1', title: 'x', prompt: 'y' };
  await shadowRoute(task);
  assert.equal(calls.length, 0);
  assert.equal(task.jevRoute, undefined);
});

test('records the pick with score and confidence, sends a bearer key', async () => {
  mockFetch(() => ok(1.8, 0.9));
  const task = { id: 't2', title: 'Redesign auth', prompt: 'Rework the session layer' };
  await shadowRoute(task);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.questions.difficulty.type, 'score');
  assert.equal(task.jevRoute.pick, 'opus');
  assert.equal(task.jevRoute.score, 1.8);
  assert.equal(task.jevRoute.confidence, 0.9);
});

test('asks once per card: a re-run keeps the first pick', async () => {
  mockFetch(() => ok(0.1));
  const task = { id: 't3', title: 'typo', jevRoute: { pick: 'sonnet', score: 1 } };
  await shadowRoute(task);
  assert.equal(calls.length, 0);
  assert.equal(task.jevRoute.pick, 'sonnet');
});

test('API error or bad response: card untouched, nothing thrown', async () => {
  const task = { id: 't4', title: 'x' };
  mockFetch(() => ({ ok: false, status: 529 }));
  await shadowRoute(task);
  mockFetch(() => ({ ok: true, json: async () => ({ answers: {} }) }));
  await shadowRoute(task);
  mockFetch(() => { throw new Error('offline'); });
  await shadowRoute(task);
  assert.equal(task.jevRoute, undefined);
});

test('buildRequest trims a huge prompt to stay under the state limit', () => {
  const req = buildRequest({ title: 't', prompt: 'a'.repeat(MAX_PROMPT_CHARS + 5000) });
  assert.equal(req.state.card.prompt.length, MAX_PROMPT_CHARS);
  assert.equal(req.model, 'jev-latest');
});
