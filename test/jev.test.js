const fs = require('fs');
const os = require('os');
const path = require('path');
// KFK_DATA_DIR must be set before requiring lib/store so save() never
// touches the real board's tasks.json.
process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-jev-'));

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { shadowRoute, pickModel, validScore, buildRequest, MAX_PROMPT_CHARS, MODEL } = require('../lib/jev');
const { summarize } = require('../scripts/jev-report');

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
const ok = (score, confidence = 0.8, model = MODEL) => ({
  ok: true,
  json: async () => ({ model, answers: { difficulty: { type: 'score', score, confidence } } }),
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
  assert.equal(task.jevRoute.model, MODEL);
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
  assert.equal(req.model, MODEL);
});

test('validScore: only a finite score on the 0 to 2 scale counts', () => {
  assert.equal(validScore(0), true);
  assert.equal(validScore(2), true);
  assert.equal(validScore(1.5), true);
  assert.equal(validScore(-0.01), false);
  assert.equal(validScore(2.01), false);
  assert.equal(validScore(Number.NaN), false);
  assert.equal(validScore(Number.POSITIVE_INFINITY), false);
  assert.equal(validScore('1'), false);
});

test('a score outside 0 to 2 leaves the card untouched', async () => {
  const task = { id: 't5', title: 'x' };
  for (const score of [5, -1, Number.NaN]) {
    mockFetch(() => ok(score));
    await shadowRoute(task);
    assert.equal(calls.length, 1);
    assert.equal(task.jevRoute, undefined);
  }
});

test('a non-numeric confidence is stored as null, and a missing model too', async () => {
  mockFetch(() => ({
    ok: true,
    json: async () => ({ answers: { difficulty: { type: 'score', score: 0.2, confidence: 'high' } } }),
  }));
  const task = { id: 't6', title: 'typo', prompt: 'fix the label' };
  await shadowRoute(task);
  assert.equal(task.jevRoute.pick, 'haiku');
  assert.equal(task.jevRoute.confidence, null);
  assert.equal(task.jevRoute.model, null);
});

test('jev-report shows confidence and version, and a bad score does not throw', () => {
  const { rows, cheaper, agree } = summarize([
    {
      title: 'Redesign auth',
      jevRoute: { pick: 'haiku', score: 0.2, confidence: 0.4, model: 'jev-1.13.0' },
      modelUsed: 'claude-opus-4-5',
      stats: { costUsd: 1.5 },
      status: 'done',
    },
    {
      title: 'Broken score',
      jevRoute: { pick: 'sonnet', score: 'nope' },
      modelUsed: 'sonnet',
      status: 'review',
    },
  ]);
  assert.equal(rows[0].jev, 'haiku (0.20)');
  assert.equal(rows[0].confidence, '0.40');
  assert.equal(rows[0].version, 'jev-1.13.0');
  assert.equal(rows[0].used, 'opus');
  assert.equal(rows[0].cost, '$1.50');
  assert.equal(cheaper, 1);
  assert.equal(rows[1].jev, 'sonnet (?)');
  assert.equal(rows[1].confidence, '');
  assert.equal(agree, 1);
});
