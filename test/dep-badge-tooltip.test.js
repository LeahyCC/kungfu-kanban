/* Dependency badge tooltip: the "Waits until done:" branch must escape its
 * title exactly once. Regression for #65, where the names were escaped twice
 * so "A & B" showed up in the tooltip as "A &amp; B". */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDom } = require('./helpers/fake-dom.js');

const dom = installFakeDom();

let state, board;

test.before(async () => {
  ({ state } = await import('../public/js/state.js'));
  board = await import('../public/js/board.js');
  dom.restoreTimers();
});

function mkTask(id, over = {}) {
  return {
    id,
    title: `Task ${id}`,
    status: 'backlog',
    prompt: `prompt ${id}`,
    cwd: '/repo',
    createdAt: '2026-07-01T00:00:00Z',
    ...over,
  };
}

test('waits-until-done tooltip escapes dependency titles once', () => {
  state.tasks = [
    mkTask('dep', { title: 'Fix A & B <now>' }),
    mkTask('mine', { v: 1, deps: ['dep'] }),
  ];
  board.__resetBoardForTests();
  board.setFilter('');
  board.render();

  const card = dom.document.querySelector('#board').querySelectorAll('.card')
    .find((c) => c.dataset.id === 'mine');
  const html = card.innerHTML;

  assert.match(html, /title="Waits until done: Fix A &amp; B &lt;now&gt;"/);
  assert.doesNotMatch(html, /&amp;amp;|&amp;lt;/, 'no double-escaped entities');
});
