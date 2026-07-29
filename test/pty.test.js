/* Built-in terminal sessions (lib/pty.js + lib/pty.py).
 *
 * These drive a REAL pty end to end — spawn a shell, type at it, read what it
 * prints back, resize it, kill it. That is the only check that proves the
 * python helper's fd wiring (stdin/stdout/fd-3) is right; a mocked child would
 * pass while the terminal stayed a black box.
 *
 * KFK_SHELL pins /bin/sh so the tests don't inherit the developer's ~/.zshrc
 * (a slow prompt or a `clear` in it would make the assertions flaky). */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.KFK_SHELL = '/bin/sh';
const pty = require('../lib/pty');

// Collect output until `re` matches or we run out of patience.
function waitFor(id, re, ms = 8000) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const handle = pty.attach(id, (chunk) => {
      seen += chunk.toString('utf8');
      if (re.test(seen)) { done(); resolve(seen); }
    });
    if (!handle) return reject(new Error('no such session'));
    seen += handle.backlog.toString('utf8');
    if (re.test(seen)) { handle.detach(); return resolve(seen); }
    const timer = setTimeout(() => {
      done();
      reject(new Error(`timed out waiting for ${re} — saw: ${JSON.stringify(seen.slice(-400))}`));
    }, ms);
    function done() { clearTimeout(timer); handle.detach(); }
  });
}

// A failed assertion must not leak a live shell into the next test's session cap
test.beforeEach(() => pty.killAll());
test.after(() => pty.killAll());

test('a session runs a real shell: keystrokes in, output back', async () => {
  const { session, error } = pty.create({ cwd: os.tmpdir(), cols: 80, rows: 24 });
  assert.equal(error, undefined, 'session started');
  pty.write(session.id, Buffer.from('echo hello-from-the-dojo\n'));
  const out = await waitFor(session.id, /hello-from-the-dojo/);
  assert.match(out, /hello-from-the-dojo/);
  pty.kill(session.id);
});

test('the shell starts in the requested directory; a bogus one falls back to $HOME', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-term-'));
  const a = pty.create({ cwd: dir, cols: 80, rows: 24 }).session;
  pty.write(a.id, Buffer.from('pwd\n'));
  // macOS symlinks /tmp -> /private/tmp, so compare the resolved paths
  const out = await waitFor(a.id, new RegExp(path.basename(dir)));
  assert.match(out, new RegExp(path.basename(dir)));
  pty.kill(a.id);

  const b = pty.create({ cwd: '/nope/not/a/real/dir', cols: 80, rows: 24 }).session;
  assert.equal(b.cwd, os.homedir(), 'a missing cwd falls back to home instead of failing');
  pty.kill(b.id);
});

test('it is a TTY, and resize reaches the shell through the control fd', async () => {
  const { session } = pty.create({ cwd: os.tmpdir(), cols: 100, rows: 30 });
  // `tty` only says "not a tty" over a pipe — this is the check that the pty
  // (and therefore an interactive ~/.zshrc, colors, and TUIs) really exists.
  pty.write(session.id, Buffer.from('tty; stty size\n'));
  const first = await waitFor(session.id, /\d+ \d+/);
  assert.doesNotMatch(first, /not a tty/, 'the shell has a controlling terminal');
  assert.match(first, /30 100/, 'the pty opened at the size we asked for');

  pty.resize(session.id, 120, 40);
  await new Promise((r) => setTimeout(r, 150)); // let the ioctl land
  pty.write(session.id, Buffer.from('stty size\n'));
  const second = await waitFor(session.id, /40 120/);
  assert.match(second, /40 120/, 'resize reached the pty');
  pty.kill(session.id);
});

test('scrollback is kept for a reattaching client and capped', async () => {
  const { session } = pty.create({ cwd: os.tmpdir(), cols: 80, rows: 24 });
  pty.write(session.id, Buffer.from('echo marker-one\n'));
  await waitFor(session.id, /marker-one/);
  // a client that shows up later still gets the history
  const late = pty.attach(session.id, () => {});
  assert.match(late.backlog.toString('utf8'), /marker-one/, 'backlog replays to a new client');
  late.detach();
  pty.kill(session.id);
});

test('exit is reported, and a killed session stops accepting input', async () => {
  const { session } = pty.create({ cwd: os.tmpdir(), cols: 80, rows: 24 });
  pty.write(session.id, Buffer.from('exit\n'));
  await waitFor(session.id, /session ended/);
  assert.equal(pty.get(session.id).exited, true, 'exit is recorded on the session');
  assert.equal(pty.write(session.id, Buffer.from('x')), false, 'writes to a dead shell are refused');
  pty.kill(session.id);
  assert.equal(pty.get(session.id), null, 'killing removes it from the registry');
  assert.equal(pty.write(session.id, Buffer.from('x')), false, 'writes to a gone session are refused');
});

test('a card gets one shell, and reopening finds it instead of stacking more', async () => {
  const a = pty.create({ cwd: os.tmpdir(), cols: 80, rows: 24, taskId: 'card-1', label: 'Fix the thing' }).session;
  assert.equal(a.taskId, 'card-1', 'the session carries its card');
  assert.equal(a.label, 'Fix the thing');

  const found = pty.forTask('card-1');
  assert.equal(found.id, a.id, 'the card finds its own shell');
  // The raw session holds a ChildProcess: leaking it into res.json() would
  // throw on the circular structure, so forTask must hand back the public shape.
  assert.equal(found.child, undefined, 'no child process in the public shape');
  assert.equal(JSON.parse(JSON.stringify(found)).id, a.id, 'serializable as-is');

  assert.equal(pty.forTask('other-card'), null, 'another card has no shell yet');
  assert.equal(pty.forTask(null), null, 'no card id, no session');
  assert.equal(pty.forTask(undefined), null);

  // An ended shell must not be handed back as a dead pane — the card should get
  // a fresh one next time it is opened.
  pty.write(a.id, Buffer.from('exit\n'));
  await waitFor(a.id, /session ended/);
  assert.equal(pty.forTask('card-1'), null, 'an exited shell is not reused');
  pty.kill(a.id);
});

test('the session count is capped so a runaway client cannot fork-bomb the Mac', () => {
  const made = [];
  for (let i = 0; i < pty.MAX_SESSIONS; i++) {
    const r = pty.create({ cwd: os.tmpdir(), cols: 80, rows: 24 });
    assert.equal(r.error, undefined, `session ${i} started`);
    made.push(r.session.id);
  }
  const over = pty.create({ cwd: os.tmpdir(), cols: 80, rows: 24 });
  assert.match(over.error || '', /too many terminals/);
  assert.equal(pty.list().length, pty.MAX_SESSIONS);
  for (const id of made) pty.kill(id);
  assert.equal(pty.list().length, 0);
});
