// Launch the claude CLI with the prompt on stdin instead of argv.
//
// Windows caps a whole command line at 32767 chars, so a big Sensei snapshot or
// a long card prompt as `-p -- <prompt>` made spawn() throw ENAMETOOLONG
// synchronously. That throw escaped an async function and the unhandled
// rejection took the whole server (and every running card) down on 2026-10-20.
// `claude -p` reads its prompt from stdin when none is on argv, which has no
// size limit.
//
// A synchronous spawn failure (bad cwd, EINVAL, E2BIG on some platform) must
// not crash the caller either, so it is converted into the same async 'error'
// event a normal launch failure emits. Callers already handle that path.
const { EventEmitter } = require('events');

function failedChild(err) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  child.kill = () => {};
  child.unref = () => {};
  setImmediate(() => child.emit('error', err));
  return child;
}

// opts is passed to spawn; stdout/stderr stay piped, stdin carries the prompt.
// child_process.spawn is looked up per call so tests can stub it.
function spawnClaude(args, prompt, opts = {}) {
  let child;
  try {
    child = require('child_process').spawn('claude', args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    return failedChild(err);
  }
  if (child.stdin) {
    // The child dying before it reads everything (EPIPE) surfaces on stdin as
    // an 'error' event; the 'close'/'error' handlers on the child report the
    // real outcome, so this one must not become an uncaught exception.
    child.stdin.on('error', () => {});
    try {
      child.stdin.end(prompt);
    } catch {}
  }
  return child;
}

module.exports = { spawnClaude };
