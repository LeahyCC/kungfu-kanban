// Regression: every Sensei run failed on 2026-10-21 with "Prompt is too long ·
// ~1281949 tokens (limit 1000000)". `--tools ''` removes built-in tools only;
// the claude CLI still loaded every MCP connector and skill from the user's
// global config (measured on the board's machine: 755,616 tokens of context for
// a one-line prompt, 8,124 with --strict-mcp-config). The Sensei needs none of
// it, so its spawn must opt out of both.
//
// child_process.spawn is stubbed BEFORE lib/manager is required.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');

const calls = [];
cp.spawn = (cmd, args, opts) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new PassThrough();
  const call = { cmd, args, opts, stdin: '' };
  child.stdin.on('data', (d) => (call.stdin += d));
  calls.push(call);
  child.pid = 99998;
  child.kill = () => {};
  child.unref = () => {};
  return child;
};

process.env.KFK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-mgr-args-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
store.state.settings.keepAwake = false;
const manager = require('../lib/manager');

test('senseiArgs keeps MCP servers and skills out of the context', () => {
  const args = manager.senseiArgs({ model: 'default', effort: 'default' });
  assert.ok(args.includes('--strict-mcp-config'), 'no MCP servers without an explicit --mcp-config');
  assert.ok(!args.includes('--mcp-config'), 'and none is passed');
  assert.ok(args.includes('--disable-slash-commands'), 'no skill listing');
  const t = args.indexOf('--tools');
  assert.deepEqual(args.slice(t, t + 2), ['--tools', '']);
  assert.equal(args[args.length - 1], '-p', 'prompt stays on stdin (#153)');
});

test('a real Sensei invocation spawns claude with those arguments', async () => {
  await manager.invoke('task finished and awaits review: "x" (id x)');
  const call = calls.find((c) => c.cmd === 'claude');
  assert.ok(call, 'claude was spawned');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.ok(call.args.includes('--disable-slash-commands'));
  assert.ok(call.stdin.length > 0, 'the snapshot rode stdin');
  assert.ok(!call.args.includes(call.stdin), 'not on argv');
  manager.stopCurrent();
});
