// Regression: a permission_denials result at bypassPermissions must NOT flag
// the card blocked — at bypass the only possible denial is an explicit deny
// rule in settings, and the old behavior told the user to "raise to
// bypassPermissions" they were already at (an unresolvable attention loop).
process.env.KFK_DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'kfk-test-')
);
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { handleEvent } = require('../lib/runner');

function resultEvt() {
  return {
    type: 'result',
    result: 'did the work',
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf .playwright-mcp' } }],
  };
}

test('denials at bypassPermissions: transcript note only, no block, no error', () => {
  const task = { id: 'byp-1', title: 'x', permissionMode: 'bypassPermissions' };
  handleEvent(task, resultEvt());
  assert.equal(task.permissionBlocked, undefined);
  assert.equal(task.error, undefined);
});

test('denials at acceptEdits: card is blocked and the error names the remedy', () => {
  const task = { id: 'acc-1', title: 'x', permissionMode: 'acceptEdits' };
  handleEvent(task, resultEvt());
  assert.deepEqual(task.permissionBlocked, ['Bash rm -rf .playwright-mcp']);
  assert.match(task.error, /Blocked on permission/);
  assert.match(task.error, /deny rule/); // deny rules win at every mode — say so
});
