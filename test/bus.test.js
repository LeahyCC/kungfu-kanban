const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { subEnv } = require('../lib/bus');

test('subEnv: deletes ANTHROPIC_API_KEY so subscription auth always wins', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-should-never-survive';
  try {
    assert.equal(subEnv().ANTHROPIC_API_KEY, undefined);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('subEnv: NODE_PATH includes this app\'s own node_modules, so a card in any cwd can require(\'playwright\')', () => {
  const env = subEnv();
  const ownNodeModules = path.join(__dirname, '..', 'node_modules');
  assert.ok(
    env.NODE_PATH.split(path.delimiter).includes(ownNodeModules),
    `expected NODE_PATH (${env.NODE_PATH}) to include ${ownNodeModules}`,
  );
});

test('subEnv: an existing NODE_PATH is preserved, not clobbered', () => {
  const prev = process.env.NODE_PATH;
  process.env.NODE_PATH = '/some/other/path';
  try {
    const env = subEnv();
    const parts = env.NODE_PATH.split(path.delimiter);
    assert.ok(parts.includes('/some/other/path'));
    assert.ok(parts.includes(path.join(__dirname, '..', 'node_modules')));
  } finally {
    if (prev === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = prev;
  }
});
