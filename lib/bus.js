// Central pub/sub for SSE broadcasts, so modules can broadcast without a
// require cycle back to server.js. server.js subscribes the SSE writer once.
let sink = () => {};

function subscribe(fn) {
  sink = fn;
}

function broadcast(msg) {
  sink(msg);
}

// Force subscription auth: never let an API key in the environment win.
function subEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

module.exports = { broadcast, subscribe, subEnv };
