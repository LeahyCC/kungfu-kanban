// Regression for #122: a run ending on plain text streamed that text as an
// `assistant` transcript entry, then unconditionally re-appended the same
// text as a `result` entry — the same message rendered twice in the
// transcript. The `result` entry should be skipped when it exactly echoes
// the last streamed `assistant` text, but still shown when it's new content
// or the only text the run produced.
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'kfk-test-')
);
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { handleEvent } = require('../lib/runner');
const store = require('../lib/store');

function assistantEvt(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function resultEvt(result) {
  return { type: 'result', result };
}

function transcriptKinds(id) {
  store.flushTranscripts(id);
  return store.readTranscript(id).map((e) => e.kind);
}

test('result identical to last streamed assistant text adds no second entry', () => {
  const task = { id: 'dedup-1', title: 'x' };
  handleEvent(task, assistantEvt('done, all set'));
  handleEvent(task, resultEvt('done, all set'));
  assert.deepEqual(transcriptKinds(task.id), ['assistant']);
  assert.equal(task.resultText, 'done, all set');
});

test('result text that differs from the last streamed assistant text is still shown', () => {
  const task = { id: 'dedup-2', title: 'x' };
  handleEvent(task, assistantEvt('working on it'));
  handleEvent(task, resultEvt('finished with a different summary'));
  assert.deepEqual(transcriptKinds(task.id), ['assistant', 'result']);
});

test('result with no prior assistant text is still shown', () => {
  const task = { id: 'dedup-3', title: 'x' };
  handleEvent(task, resultEvt('tool-only run summary'));
  assert.deepEqual(transcriptKinds(task.id), ['result']);
});

test('empty result never adds an entry', () => {
  const task = { id: 'dedup-4', title: 'x' };
  handleEvent(task, assistantEvt('some text'));
  handleEvent(task, resultEvt(''));
  assert.deepEqual(transcriptKinds(task.id), ['assistant']);
});
